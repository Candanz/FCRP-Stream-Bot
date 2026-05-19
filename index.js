const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const winston = require('winston');
const path = require('path');
const { log } = require('console');

dotenv.config();

class MySqlTransport extends winston.Transport {
    constructor(opts) {
        super(opts);
        this.pool = opts.pool;
    }
    async log(info, callback) {
        setImmediate(() => this.emit('logged', info));
        try {
            await this.pool.execute(
                'INSERT INTO bot_logs (level, context, message) VALUES (?, ?, ?)',
                [info.level, info.context || 'SYSTEM', info.message]
            );
        } catch (err) {
            console.error('Failed to write log to MySQL:', err.message);
        }
        callback();
    }
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, context, message }) => {
            return `[${timestamp}] [${level.toUpperCase()}] [${context || 'SYSTEM'}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: path.join(__dirname, 'combined.log') }),
        new MySqlTransport({ pool: pool })
    ]
});

// -
let twitchAccessToken = '';

async function getTwitchAccessToken() {
    try {
        const response = await axios.post(`https://id.twitch.tv/oauth2/token`, null, {
            params: {
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                grant_type: 'client_credentials'
            }
        });
        twitchAccessToken = response.data.access_token;
        logger.info({ message: 'Generated new Twitch app access token.', context: 'TWITCH_API' });
    } catch (error) {
        logger.error({ message: `Error fetching Twitch token: ${error.message}`, context: 'TWITCH_API' });
    }
}

async function getTwitchStreams(twitchLogins) {
    if (twitchLogins.length === 0) return [];
    try {
        const query = twitchLogins.map(login => `user_login=${login}`).join('&');
        const response = await axios.get(`https://api.twitch.tv/helix/streams?${query}`, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${twitchAccessToken}`
            }
        });
        return response.data.data;
    } catch (error) {
        if (error.response?.status === 401) {
            await getTwitchAccessToken();
            return getTwitchStreams(twitchLogins);
        }
        return [];
    }
}

async function getTwitchUserDetails(userId) {
    try {
        const response = await axios.get(`https://api.twitch.tv/helix/users?id=${userId}`, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${twitchAccessToken}`
            }
        });
        return response.data.data[0] || null;
    } catch (error) {
        logger.error({ message: `Error fetching Twitch user details: ${error.message}`, context: 'TWITCH_API' });
        return null;
    }
}

// 
const commands = [
    new SlashCommandBuilder()
        .setName('track-add')
        .setDescription('Add a user and their Twitch username to the tracking list')
        .addUserOption(option => option.setName('user').setDescription('The Discord member to track').setRequired(true))
        .addStringOption(option => option.setName('twitch').setDescription('Their exact Twitch username').setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('track-remove')
        .setDescription('Remove a user from the tracking list')
        .addUserOption(option => option.setName('user').setDescription('The Discord member to remove').setRequired(true)),

    new SlashCommandBuilder()
        .setName('track-clear')
        .setDescription('Completely clear the tracking list'),

    new SlashCommandBuilder()
        .setName('keyword-add')
        .setDescription('Add a keyword required to trigger the Live role')
        .addStringOption(option => option.setName('keyword').setDescription('The keyword to add').setRequired(true)),

    new SlashCommandBuilder()
        .setName('keyword-remove')
        .setDescription('Remove a keyword')
        .addStringOption(option => option.setName('keyword').setDescription('The keyword to remove').setRequired(true)),

    new SlashCommandBuilder()
        .setName('track-list')
        .setDescription('List all currently tracked users and their Twitch usernames'),

    new SlashCommandBuilder()
        .setName('keyword-list')
        .setDescription('List all active keywords for stream title filtering'),

    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check the bot\'s responsiveness and API latency'),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription('View a list of all available commands and how to use the bot'),
];

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// 
client.once('clientReady', async () => {
    logger.info({ message: `Logged into Discord API as ${client.user.tag}`, context: 'DISCORD_LIFECYCLE' });
    await getTwitchAccessToken();

    await pool.execute('INSERT IGNORE INTO bot_config (config_key, config_value) VALUES (?, ?)', ['announcement_channel_id', process.env.ANNOUNCEMENT_CHANNEL_ID || '']);
    await pool.execute('INSERT IGNORE INTO bot_config (config_key, config_value) VALUES (?, ?)', ['allowed_admin_roles', '']);
    await pool.execute('INSERT IGNORE INTO bot_config (config_key, config_value) VALUES (?, ?)', ['announcement_ping_role_id', '']);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        logger.info({ message: 'Successfully published global slash commands definitions.', context: 'DISCORD_LIFECYCLE' });
    } catch (error) {
        logger.error({ message: `Failed to register slash commands: ${error.message}`, context: 'DISCORD_LIFECYCLE' });
    }

    cleanupLiveRoles()

    setInterval(checkStreams, 2 * 60 * 1000);

    checkStreams();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, user, member } = interaction;

    try {
        const adminCommands = ['track-add', 'track-remove', 'track-clear', 'keyword-add', 'keyword-remove', 'track-list', 'keyword-list'];
        
        if (adminCommands.includes(commandName)) {
            const [configRows] = await pool.execute('SELECT config_value FROM bot_config WHERE config_key = "allowed_admin_roles"');
            const allowedRolesString = configRows[0]?.config_value || '';
            
            const allowedRoleIds = allowedRolesString.split(',').map(id => id.trim()).filter(id => id.length > 0);

            const isServerAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

            const hasCustomRole = member.roles.cache.some(role => allowedRoleIds.includes(role.id));

            if (!isServerAdmin && !hasCustomRole) {
                logger.warn({ message: `Unauthorized interaction attempt for /${commandName} by user ${user.tag}`, context: 'SECURITY_GUARD' });
                await interaction.reply({ content: '🚫 You do not have permission to use this management command.', ephemeral: true });
                return;
            }
        }

        if (commandName === 'ping') {
            const sent = await interaction.reply({ content: '🏓 Pinging...', withResponse: true });
            await interaction.editReply(`🏓 **Pong!**\n• **Bot Latency:** \`${sent.createdTimestamp - interaction.createdTimestamp}ms\`\n• **API Latency:** \`${Math.round(client.ws.ping)}ms\``);
            return;
        }

        if (commandName === 'help') {
            await interaction.reply({ content: '**FCRP Stream Bot Commands:**\n\n' +
                '• `/track-add user:@member twitch:username` - Start tracking a user\'s Twitch stream.\n' +
                '• `/track-remove user:@member` - Stop tracking a user.\n' +
                '• `/track-list` - List all tracked users and their Twitch usernames.\n' +
                '• `/track-clear` - Clear all tracked users.\n' +
                '• `/keyword-add keyword:term` - Add a keyword to filter stream titles.\n' +
                '• `/keyword-remove keyword:term` - Remove a keyword from the filter.\n' +
                '• `/keyword-list` - List all active keywords for stream title filtering.\n' +
                '• `/help` - Show this help message.' });
            return;
        }

        if (commandName === 'track-add') {
            const targetUser = options.getUser('user');
            const twitchUsername = options.getString('twitch').toLowerCase().trim();
            await pool.execute('INSERT INTO tracked_users (discord_id, twitch_username) VALUES (?, ?) ON DUPLICATE KEY UPDATE twitch_username = VALUES(twitch_username)', [targetUser.id, twitchUsername]);
            logger.info({ message: `Admin ${user.tag} tracked user ${targetUser.tag} -> Twitch: ${twitchUsername}`, context: 'COMMAND_TRACK' });
            await interaction.reply(`🎯 Tracked **${targetUser.username}** matching Twitch account: \`${twitchUsername}\`.`);
        }

        if (commandName === 'track-remove') {
            const targetUser = options.getUser('user');
            await pool.execute('DELETE FROM tracked_users WHERE discord_id = ?', [targetUser.id]);
            logger.info({ message: `Admin ${user.tag} removed user ${targetUser.tag} from tracking.`, context: 'COMMAND_TRACK' });
            await interaction.reply(`❌ Removed **${targetUser.username}** from tracking.`);
        }

        if (commandName === 'track-clear') {
            await pool.execute('DELETE FROM tracked_users');
            logger.warn({ message: `Admin ${user.tag} purged the tracking database table.`, context: 'COMMAND_TRACK' });
            await interaction.reply('🧹 Entire Twitch tracking table has been wiped clean.');
        }

        if (commandName === 'keyword-add') {
            const word = options.getString('keyword').toLowerCase().trim();
            await pool.execute('INSERT IGNORE INTO keywords (keyword) VALUES (?)', [word]);
            logger.info({ message: `Admin ${user.tag} added keyword filter: ${word}`, context: 'COMMAND_KEYWORD' });
            await interaction.reply(`✅ Keyword \`${word}\` is now active.`);
        }

        if (commandName === 'keyword-remove') {
            const word = options.getString('keyword').toLowerCase().trim();
            await pool.execute('DELETE FROM keywords WHERE keyword = ?', [word]);
            logger.info({ message: `Admin ${user.tag} removed keyword filter: ${word}`, context: 'COMMAND_KEYWORD' });
            await interaction.reply(`❌ Removed keyword: \`${word}\``);
        }

        if (commandName === 'track-list') {
            const [users] = await pool.execute('SELECT * FROM tracked_users');
            const usersList = users.length > 0 ? users.map(u => `<@${u.discord_id}> (\`${u.twitch_username}\`)`).join('\n') : 'None';
            await interaction.reply(`**Tracked Users:**\n${usersList}`);
        }

        if (commandName === 'keyword-list') {
            const [kwsRows] = await pool.execute('SELECT * FROM keywords');
            const kwsList = kwsRows.length > 0 ? kwsRows.map(k => `\`${k.keyword}\``).join(', ') : 'No active keywords';
            await interaction.reply(`**Active Keywords for Stream Title Filtering:**\n${kwsList}`);
        }   
    } catch (dbError) {
        logger.error({ message: `Command error "/${commandName}" by ${user.tag}: ${dbError.message}`, context: 'COMMAND_ERROR' });
    }
});

// --- NEW: STARTUP CLEANUP ROUTINE ---
async function cleanupLiveRoles() {
    logger.info({ message: 'Initiating startup cleanup routine.', context: 'CLEANUP_ENGINE' });
    const guild = client.guilds.cache.first();
    if (!guild) return logger.info({ message: 'No guild detected in cache yet.', context: 'CLEANUP_ENGINE' });

    const roleId = process.env.LIVE_ROLE_ID;
    const role = guild.roles.cache.get(roleId);
    if (!role) return logger.error({ message: `Live Role ID "${roleId}" not found in server.`, context: 'CLEANUP_ENGINE' });
    try {
        // 1. Reset all stream session tracking locks in the database
        await pool.execute('UPDATE tracked_users SET last_stream_id = NULL');
        logger.info({ message: 'All MySQL last_stream_id stream locks have been reset to NULL.', context: 'CLEANUP_ENGINE' });

        // 2. Fetch all members who currently have the live role assigned
        // We use fetch() here instead of cache to guarantee we bypass old Discord client states
        const membersWithRole = await guild.members.fetch().then(members => 
            members.filter(member => member.roles.cache.has(roleId))
        );

        if (membersWithRole.size === 0) {
            logger.info({ message: 'No members with ghost Live roles detected during cleanup.', context: 'CLEANUP_ENGINE' });
            return;
        }

        logger.info({ message: `Found ${membersWithRole.size} members with ghost live roles. Stripping roles now...`, context: 'CLEANUP_ENGINE' });

        // 3. Loop through and strip the role from those members
        for (const [id, member] of membersWithRole) {
            await member.roles.remove(role);
            logger.info({ message: `Stripped ghost Live role from ${member.user.tag} during boot cleanup`, context: 'CLEANUP_ENGINE' });
        }

    } catch (err) {
        logger.error({ message: `Failed to complete boot cleanup sequence: ${err.message}`, context: 'CLEANUP_ENGINE' });
    }
}

async function checkStreams() {
    let guild = client.guilds.cache.first();
    if (!guild) {
        try {
            const guilds = await client.guilds.fetch();
            if (guilds.size === 0) {
                logger.warn({ message: '[LOOP ABORT] Bot is not joined to any Discord servers.', context: 'LOOP_STATUS' });
                return;
            }
            guild = await guilds.first().fetch();
        } catch (fetchErr) {
            logger.error({ message: `[LOOP ERROR] Failed to fetch guild architecture: ${fetchErr.message}`, context: 'LOOP_ERROR' });
            return;
        }
    }

    // 2. Validate Role Configuration
    const roleId = process.env.LIVE_ROLE_ID;
    const role = guild.roles.cache.get(roleId);
    if (!role) {
        logger.error({ message: `Critical configuration error: Live role ID "${roleId}" not found in guild. Please check your environment variables and ensure the role exists.`, context: 'CONFIG_VALIDATION' });
        return;
    }

    try {
        // 3. Fetch configurations and check database records
        const [users] = await pool.execute('SELECT * FROM tracked_users');
        const [kwsRows] = await pool.execute('SELECT * FROM keywords');
        const kws = kwsRows.map(k => k.keyword);

        if (users.length === 0) {
            logger.warn({ message: 'No users registered in the "tracked_users" database table. Use /track-add to start tracking Twitch streamers.', context: 'LOOP_STATUS' });
            return;
        }

        const [configRows] = await pool.execute('SELECT config_value FROM bot_config WHERE config_key = "announcement_channel_id"');
        const channelId = configRows[0]?.config_value;
        const announcementChannel = guild.channels.cache.get(channelId);
        if (!announcementChannel) {
            logger.warn({ message: `Announcement channel ID "${channelId}" not found in cache. Announcements will be skipped.`, context: 'LOOP_STATUS' });
        }

        const [pingConfigRows] = await pool.execute('SELECT config_value FROM bot_config WHERE config_key = "announcement_ping_role_id"');
        const pingRoleId = pingConfigRows[0]?.config_value;
        const pingRole = guild.roles.cache.get(pingRoleId);
        if (!pingRole) {
            logger.warn({ message: `Announcement ping role ID "${pingRoleId}" not found in cache. Announcement pings will be skipped.`, context: 'LOOP_STATUS' });
        }

        const twitchToUserMap = new Map();
        users.forEach(u => twitchToUserMap.set(u.twitch_username, u));

        const twitchLogins = users.map(u => u.twitch_username);
        
        const liveStreams = await getTwitchStreams(twitchLogins);
        const liveTwitchUsernames = new Set(liveStreams.map(s => s.user_login.toLowerCase()));

        for (const stream of liveStreams) {
            const twitchLogin = stream.user_login.toLowerCase();
            const dbUserObj = twitchToUserMap.get(twitchLogin);
            if (!dbUserObj) continue;

            try {
                const member = await guild.members.fetch(dbUserObj.discord_id);
                const streamTitle = stream.title.toLowerCase();
                const matchesKeywords = kws.length === 0 || kws.some(kw => streamTitle.includes(kw));

                if (matchesKeywords) {
                    if (!member.roles.cache.has(roleId)) {
                        await member.roles.add(role);
                        logger.info({ message: `Applied Live Role to ${member.user.tag}`, context: 'LIVE_ENGINE' });
                    }

                    if (dbUserObj.last_stream_id !== stream.id) {
                        await pool.execute('UPDATE tracked_users SET last_stream_id = ? WHERE discord_id = ?', [stream.id, dbUserObj.discord_id]);

                        if (announcementChannel) {
                            const twitchUser = await getTwitchUserDetails(stream.user_id);
                            const profileImageUrl = twitchUser ? twitchUser.profile_image_url : '';
                            const parsedThumbnail = stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') + `?t=${Date.now()}`;

                            const embed = new EmbedBuilder()
                                .setColor('#9146FF')
                                .setTitle(stream.title)
                                .setURL(`https://twitch.tv/${stream.user_login}`)
                                .setAuthor({ name: `${stream.user_name} is now LIVE on Twitch!`, iconURL: profileImageUrl, url: `https://twitch.tv/${stream.user_login}` })
                                .addFields(
                                    { name: '🎮 Playing', value: stream.game_name || 'Just Chatting', inline: true },
                                    { name: '👥 Viewers', value: String(stream.viewer_count), inline: true }
                                )
                                .setImage(parsedThumbnail)
                                .setThumbnail(profileImageUrl)
                                .setTimestamp();
                            
                            let content = `**${stream.user_name}** is now live! Go show some support! \n<https://twitch.tv/${stream.user_login}>`;
                            if (pingRole) {
                                content = `${pingRole.toString()}\n${content}`;
                            }
                        
                            await announcementChannel.send({ content, embeds: [embed] });
                            logger.info({ message: `Dispatched live announcement embed for channel ${stream.user_login}`, context: 'LIVE_ENGINE' });
                        }
                    }
                } else {
                    if (member.roles.cache.has(roleId)) {
                        await member.roles.remove(role);
                        logger.info({ message: `Stripped Live Role from ${member.user.tag} - Title did not match keywords.`, context: 'LIVE_ENGINE' });
                    }
                }
            } catch (memberErr) {
                logger.error({ message: `Failed to process server updates for Discord User ID ${dbUserObj.discord_id}:`, context: 'LIVE_ENGINE' });
            }
        }

        for (const user of users) {
            if (!liveTwitchUsernames.has(user.twitch_username)) {
                try {
                    const member = await guild.members.fetch(user.discord_id);
                    if (member.roles.cache.has(roleId)) {
                        await member.roles.remove(role);
                        logger.info({ message: `Removed role from offline channel: ${user.twitch_username}`, context: 'LIVE_ENGINE' });
                    }
                } catch (memberErr) {}

                if (user.last_stream_id !== null) {
                    await pool.execute('UPDATE tracked_users SET last_stream_id = NULL WHERE discord_id = ?', [user.discord_id]);
                }
            }
        }

    } catch (err) {
        logger.error({ message: `Fatal runtime error inside live loop calculation step: ${err.message}`, context: 'LIVE_ENGINE' });
    }
}

client.login(process.env.DISCORD_TOKEN);