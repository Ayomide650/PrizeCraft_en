require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
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

// Utility function to parse time with timezone
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
    
    // Create date object for today with GMT+1
    const now = new Date();
    const endTime = new Date();
    endTime.setHours(hours - 1, minutes, 0, 0); // GMT+1 adjustment
    
    // If time has passed today, set for tomorrow
    if (endTime <= now) {
        endTime.setDate(endTime.getDate() + 1);
    }
    
    return endTime;
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
    } catch (error) {
        console.error('Error ending giveaway:', error);
    }
}

// Check for ended giveaways every minute
cron.schedule('* * * * *', () => {
    const now = new Date();
    for (const [giveawayId, giveaway] of activeGiveaways) {
        if (now >= giveaway.endTime) {
            endGiveaway(giveawayId);
        }
    }
});

client.once('ready', () => {
    console.log(`${client.user.tag} is online!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    // Check if message is in the designated giveaway channel
    if (message.channel.id !== process.env.GIVEAWAY_CHANNEL_ID) return;
    
    // Check if user is admin
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
    
    if (message.content === '!gcreate') {
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
        
        await message.reply({ content: 'Opening giveaway creation form...', ephemeral: true });
        
        // Create an interaction for the modal
        const filter = (interaction) => interaction.customId === 'giveaway_create' && interaction.user.id === message.author.id;
        
        try {
            await message.member.send({ content: 'Please use the slash command interface to create giveaways. Use `/gcreate` in the server.' });
        } catch {
            await message.reply({ content: 'Please enable DMs or use the slash command interface for giveaway creation.', ephemeral: true });
        }
        
        return;
    }
    
    if (message.content === '!gend') {
        // Find active giveaway in this channel
        const giveawayId = Array.from(activeGiveaways.keys()).find(id => 
            activeGiveaways.get(id).channel.id === message.channel.id
        );
        
        if (!giveawayId) {
            await message.reply({ content: 'No active giveaway found in this channel.', ephemeral: true });
            return;
        }
        
        await endGiveaway(giveawayId, true);
        await message.reply({ content: 'Giveaway ended manually!', ephemeral: true });
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
            .setDescription(`**Prize:** ${giveaway.prize}\n${giveaway.description ? `**Description:** ${giveaway.description}\n` : ''}\n**Winners:** ${giveaway.winners}\n**Participants:** ${giveaway.participants.length}\n**Ends:** ${giveaway.endTime.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })}`)
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
        await interaction.reply({ content: 'You have successfully joined the giveaway!', ephemeral: true });
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
            
            // Create giveaway embed
            const embed = new EmbedBuilder()
                .setTitle('🎉 Giveaway Active')
                .setDescription(`**Prize:** ${prize}\n${description ? `**Description:** ${description}\n` : ''}\n**Winners:** ${winners}\n**Participants:** 0\n**Ends:** ${endTime.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })}`)
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
            
            const channel = interaction.client.channels.cache.get(process.env.GIVEAWAY_CHANNEL_ID);
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
            
            await interaction.reply({ content: 'Giveaway created successfully!', ephemeral: true });
            
        } catch (error) {
            await interaction.reply({ content: `Error: ${error.message}`, ephemeral: true });
        }
    }
});

// Express server for health checks (required for Render)
app.get('/', (req, res) => {
    res.send('Discord Giveaway Bot is running!');
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', uptime: process.uptime() });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
