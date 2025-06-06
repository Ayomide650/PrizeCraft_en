require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// Discord client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Store active giveaways
const activeGiveaways = new Map();

// Register slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('gcreate')
        .setDescription('Create a new giveaway (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
    new SlashCommandBuilder()
        .setName('gend')
        .setDescription('End the current giveaway and announce winners (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

// Utility function to parse time with proper timezone handling
function parseTime(timeString) {
    const timeRegex = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
    const match = timeString.match(timeRegex);
    
    if (!match) {
        throw new Error('Invalid time format. Please use format like "5:30PM" or "11:45AM"');
    }
    
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const period = match[3].toUpperCase();
    
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
        throw new Error('Invalid time values. Hours must be 1-12, minutes 0-59');
    }
    
    // Convert to 24-hour format
    if (period === 'AM' && hours === 12) {
        hours = 0;
    } else if (period === 'PM' && hours !== 12) {
        hours += 12;
    }
    
    // Create date object for exact time specified in local timezone
    const now = new Date();
    const endTime = new Date();
    
    // Set the time components
    endTime.setHours(hours, minutes, 0, 0);
    
    // If time has already passed today, set for tomorrow
    if (endTime <= now) {
        endTime.setDate(endTime.getDate() + 1);
    }
    
    return endTime;
}

// Function to format date consistently
function formatEndTime(date) {
    // Format the date to show local time consistently
    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    };
    
    return date.toLocaleString('en-US', options);
}

// Function to end giveaway
async function endGiveaway(giveawayId, forceEnd = false) {
    const giveaway = activeGiveaways.get(giveawayId);
    if (!giveaway) return;
    
    const { channel, messageId, participants, winners: numWinners, prize } = giveaway;
    
    try {
        const message = await channel.messages.fetch(messageId);
        let winnersList = [];
        
        if (participants.length === 0) {
            const embed = new EmbedBuilder()
                .setTitle('🎉 Giveaway Ended')
                .setDescription(`**Prize:** ${prize}\n\n❌ No participants joined this giveaway.`)
                .setColor('#ff0000')
                .setTimestamp();
            
            await message.edit({ embeds: [embed], components: [] });
        } else {
            // Randomly select winners
            const shuffled = [...participants].sort(() => 0.5 - Math.random());
            winnersList = shuffled.slice(0, Math.min(numWinners, participants.length));
            
            const winnersText = winnersList.map(id => `<@${id}>`).join(', ');
            
            const embed = new EmbedBuilder()
                .setTitle('🎉 Giveaway Ended')
                .setDescription(`**Prize:** ${prize}\n\n🏆 **Winners:** ${winnersText}\n\n**Total Participants:** ${participants.length}`)
                .setColor('#00ff00')
                .setTimestamp();
            
            await message.edit({ embeds: [embed], components: [] });
            
            // Tag winners in a separate message
            if (winnersList.length > 0) {
                await channel.send(`🎉 Congratulations ${winnersText}! You won: **${prize}**`);
            }
        }
        
        activeGiveaways.delete(giveawayId);
        console.log(`Giveaway ${giveawayId} ended at ${new Date().toISOString()}`);
    } catch (error) {
        console.error('Error ending giveaway:', error);
    }
}

// Check for ended giveaways every minute
cron.schedule('* * * * *', () => {
    const now = new Date();
    console.log(`Checking giveaways at ${now.toISOString()}`);
    
    for (const [giveawayId, giveaway] of activeGiveaways) {
        console.log(`Giveaway ${giveawayId} ends at ${giveaway.endTime.toISOString()}, current time: ${now.toISOString()}`);
        
        if (now >= giveaway.endTime) {
            console.log(`Ending giveaway ${giveawayId}`);
            endGiveaway(giveawayId);
        }
    }
});

client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);
    console.log(`Bot timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    console.log(`Current server time: ${new Date().toISOString()}`);
    console.log(`Current local time: ${formatEndTime(new Date())}`);
    
    // Register slash commands
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    try {
        console.log('Started refreshing application (/) commands.');
        
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    // Check if command is used in the designated giveaway channel
    if (interaction.channel.id !== process.env.GIVEAWAY_CHANNEL_ID) {
        await interaction.reply({ 
            content: 'This command can only be used in the designated giveaway channel.', 
            ephemeral: true 
        });
        return;
    }
    
    // Check if user is admin
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ 
            content: 'Only administrators can use this command.', 
            ephemeral: true 
        });
        return;
    }
    
    if (interaction.commandName === 'gcreate') {
        const modal = new ModalBuilder()
            .setCustomId('giveaway_create')
            .setTitle('Create Giveaway');
        
        const prizeInput = new TextInputBuilder()
            .setCustomId('prize')
            .setLabel('Prize')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);
        
        const durationInput = new TextInputBuilder()
            .setCustomId('duration')
            .setLabel('End Time (e.g., 5:30PM)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('Format: 5:30PM or 11:45AM');
        
        const winnersInput = new TextInputBuilder()
            .setCustomId('winners')
            .setLabel('Number of Winners')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('Enter a number');
        
        const descriptionInput = new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Description (Optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500);
        
        const firstRow = new ActionRowBuilder().addComponents(prizeInput);
        const secondRow = new ActionRowBuilder().addComponents(durationInput);
        const thirdRow = new ActionRowBuilder().addComponents(winnersInput);
        const fourthRow = new ActionRowBuilder().addComponents(descriptionInput);
        
        modal.addComponents(firstRow, secondRow, thirdRow, fourthRow);
        
        await interaction.showModal(modal);
    }
    
    if (interaction.commandName === 'gend') {
        // Find active giveaway in this channel
        const giveawayId = Array.from(activeGiveaways.keys()).find(id => 
            activeGiveaways.get(id).channel.id === interaction.channel.id
        );
        
        if (!giveawayId) {
            await interaction.reply({ 
                content: 'No active giveaway found in this channel.', 
                ephemeral: true 
            });
            return;
        }
        
        await endGiveaway(giveawayId, true);
        await interaction.reply({ 
            content: 'Giveaway ended manually and winners have been announced!', 
            ephemeral: true 
        });
    }
});

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    
    const { customId, user, message } = interaction;
    
    if (customId.startsWith('participate_')) {
        const giveawayId = customId.split('_')[1];
        const giveaway = activeGiveaways.get(giveawayId);
        
        if (!giveaway) {
            await interaction.reply({ content: 'This giveaway is no longer active.', ephemeral: true });
            return;
        }
        
        if (giveaway.participants.includes(user.id)) {
            await interaction.reply({ content: 'You are already participating in this giveaway!', ephemeral: true });
            return;
        }
        
        giveaway.participants.push(user.id);
        
        // Update the embed with new participant count
        const embed = new EmbedBuilder()
            .setTitle('🎉 Giveaway Active')
            .setDescription(`**Prize:** ${giveaway.prize}\n${giveaway.description ? `**Description:** ${giveaway.description}\n` : ''}\n**Winners:** ${giveaway.winners}\n**Participants:** ${giveaway.participants.length}\n**Ends:** ${formatEndTime(giveaway.endTime)}`)
            .setColor('#00ff00')
            .setTimestamp();
        
        const participateButton = new ButtonBuilder()
            .setCustomId(`participate_${giveawayId}`)
            .setLabel('🎁 Participate')
            .setStyle(ButtonStyle.Primary);
        
        const endButton = new ButtonBuilder()
            .setCustomId(`end_${giveawayId}`)
            .setLabel('END')
            .setStyle(ButtonStyle.Danger);
        
        const row = new ActionRowBuilder().addComponents(participateButton, endButton);
        
        await message.edit({ embeds: [embed], components: [row] });
        await interaction.reply({ content: 'You have successfully joined the giveaway! Good luck! 🍀', ephemeral: true });
    }
    
    if (customId.startsWith('end_')) {
        // Check if user is admin
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: 'Only administrators can end giveaways.', ephemeral: true });
            return;
        }
        
        const giveawayId = customId.split('_')[1];
        const giveaway = activeGiveaways.get(giveawayId);
        
        if (!giveaway) {
            await interaction.reply({ content: 'This giveaway is no longer active.', ephemeral: true });
            return;
        }
        
        // End without winners
        const embed = new EmbedBuilder()
            .setTitle('🎉 Giveaway Ended')
            .setDescription(`**Prize:** ${giveaway.prize}\n\n❌ Giveaway ended by administrator with no winners.`)
            .setColor('#ff0000')
            .setTimestamp();
        
        await message.edit({ embeds: [embed], components: [] });
        activeGiveaways.delete(giveawayId);
        
        await interaction.reply({ content: 'Giveaway ended with no winners.', ephemeral: true });
    }
});

// Handle modal submissions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    
    if (interaction.customId === 'giveaway_create') {
        const prize = interaction.fields.getTextInputValue('prize');
        const duration = interaction.fields.getTextInputValue('duration');
        const winners = parseInt(interaction.fields.getTextInputValue('winners'));
        const description = interaction.fields.getTextInputValue('description') || null;
        
        try {
            // Validate inputs
            if (isNaN(winners) || winners < 1) {
                throw new Error('Number of winners must be a positive number.');
            }
            
            const endTime = parseTime(duration);
            const giveawayId = Date.now().toString();
            
            console.log(`Creating giveaway ${giveawayId} with end time: ${endTime.toISOString()}`);
            console.log(`Formatted end time for display: ${formatEndTime(endTime)}`);
            
            // Create giveaway embed
            const embed = new EmbedBuilder()
                .setTitle('🎉 Giveaway Active')
                .setDescription(`**Prize:** ${prize}\n${description ? `**Description:** ${description}\n` : ''}\n**Winners:** ${winners}\n**Participants:** 0\n**Ends:** ${formatEndTime(endTime)}`)
                .setColor('#00ff00')
                .setTimestamp();
            
            const participateButton = new ButtonBuilder()
                .setCustomId(`participate_${giveawayId}`)
                .setLabel('🎁 Participate')
                .setStyle(ButtonStyle.Primary);
            
            const endButton = new ButtonBuilder()
                .setCustomId(`end_${giveawayId}`)
                .setLabel('END')
                .setStyle(ButtonStyle.Danger);
            
            const row = new ActionRowBuilder().addComponents(participateButton, endButton);
            
            const channel = interaction.channel;
            const giveawayMessage = await channel.send({ embeds: [embed], components: [row] });
            
            // Store giveaway data
            activeGiveaways.set(giveawayId, {
                messageId: giveawayMessage.id,
                channel: channel,
                prize: prize,
                description: description,
                winners: winners,
                endTime: endTime,
                participants: []
            });
            
            await interaction.reply({ 
                content: `🎉 Giveaway created successfully! It will end at **${formatEndTime(endTime)}**`, 
                ephemeral: true 
            });
            
        } catch (error) {
            await interaction.reply({ content: `❌ Error: ${error.message}`, ephemeral: true });
        }
    }
});

// Express server for health checks (required for Render)
app.get('/', (req, res) => {
    res.send('Discord Giveaway Bot is running!');
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        currentTime: new Date().toISOString(),
        localTime: formatEndTime(new Date())
    });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
