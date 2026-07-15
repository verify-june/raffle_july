import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
  Role,
  TextChannel,
  ChannelType,
} from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================
// 环境变量
// ============================================================
const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID; // 填了则注册为服务器指令，秒级生效

if (!token) {
  console.error('❌ Error: DISCORD_BOT_TOKEN is not defined in .env file');
  process.exit(1);
}

// ============================================================
// Discord Client
// 读取角色成员需要 GuildMembers Intent，
// 记得在 Developer Portal -> Bot -> 勾选 "SERVER MEMBERS INTENT"
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
});

// Discord 单条消息字符上限
const DISCORD_MESSAGE_LIMIT = 2000;

// ============================================================
// 斜杠指令定义：/raffle
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName('raffle')
    .setDescription('从指定身份组中随机抽取若干成员，并在指定频道公布')
    .addRoleOption((option) =>
      option.setName('role').setDescription('抽取范围：目标身份组').setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('count')
        .setDescription('抽取人数')
        .setRequired(true)
        .setMinValue(1)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('公布结果的频道（不填则默认当前频道）')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription(
          '自定义公布文案，可用 {count} 代表实际抽取人数、{role} 代表身份组名称'
        )
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];

async function registerCommands() {
  if (!clientId) {
    console.warn('⚠️ DISCORD_CLIENT_ID 未设置，跳过斜杠指令注册。');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(token!);
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      });
      console.log('✅ 已注册服务器专属斜杠指令');
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✅ 已注册全局斜杠指令（可能需要等待生效）');
    }
  } catch (error) {
    console.error('❌ 注册斜杠指令失败:', error);
  }
}

// ============================================================
// 工具函数：Fisher-Yates 洗牌，随机抽取 n 个不重复元素
// ============================================================
function pickRandom<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// 把一大串 @ 提及按 Discord 2000 字符限制切分成多条消息
function chunkMentions(header: string, mentions: string[]): string[] {
  const messages: string[] = [];
  let current = header;

  for (const mention of mentions) {
    const candidate = current.length === 0 ? mention : `${current} ${mention}`;
    if (candidate.length > DISCORD_MESSAGE_LIMIT) {
      messages.push(current);
      current = mention;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    messages.push(current);
  }
  return messages;
}

// ============================================================
// 核心逻辑：处理 /raffle 指令
// ============================================================
async function handleRaffleCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: '❌ 你没有权限执行该指令。', ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: '❌ 该指令只能在服务器内使用。', ephemeral: true });
    return;
  }

  const role = interaction.options.getRole('role', true) as Role;
  const count = interaction.options.getInteger('count', true);
  const targetChannel =
    (interaction.options.getChannel('channel') as TextChannel | null) ??
    (interaction.channel as TextChannel);
  const customMessage = interaction.options.getString('message');

  if (!targetChannel || !targetChannel.isTextBased()) {
    await interaction.reply({ content: '❌ 目标频道无效或不是文字频道。', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // 确保成员缓存完整
    await guild.members.fetch();

    const eligibleMembers = role.members.filter((m) => !m.user.bot);

    if (eligibleMembers.size === 0) {
      await interaction.editReply(`⚠️ 身份组 <@&${role.id}> 下没有找到任何成员（已排除机器人）。`);
      return;
    }

    const actualCount = Math.min(count, eligibleMembers.size);
    const winners = pickRandom([...eligibleMembers.values()], actualCount);

    // 构造公布文案：支持 {count} / {role} 占位符
    const template =
      customMessage && customMessage.trim().length > 0
        ? customMessage
        : '🎉 恭喜以下 {count} 位「{role}」成员被抽中：';

    const header = template
      .replace(/{count}/g, String(actualCount))
      .replace(/{role}/g, role.name);

    const mentionList = winners.map((m) => `<@${m.id}>`);
    const messages = chunkMentions(header, mentionList);

    for (const msg of messages) {
      await targetChannel.send(msg);
    }

    const capNote =
      count > eligibleMembers.size
        ? `\n⚠️ 注意：身份组实际只有 ${eligibleMembers.size} 人，已按全部人数抽取（少于你要求的 ${count} 人）。`
        : '';

    await interaction.editReply(
      `✅ 已在 <#${targetChannel.id}> 公布抽取结果，共 ${actualCount} 人。${capNote}`
    );
  } catch (error) {
    console.error('❌ /raffle 执行出错:', error);
    await interaction.editReply('❌ 执行过程中发生错误，请查看后台日志。');
  }
}

// ============================================================
// 事件监听
// ============================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot is online! Logged in as ${c.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'raffle') {
    await handleRaffleCommand(interaction);
  }
});

client.login(token);
