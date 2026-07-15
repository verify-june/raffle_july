import { 
  Client, 
  GatewayIntentBits, 
  Events, 
  Partials, 
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
  Role
} from 'discord.js';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = '1522168881609707562';
const guildId = '766274145922318367'; // 填了则注册为服务器指令，秒级生效

if (!token) {
  console.error('❌ Error: DISCORD_BOT_TOKEN is not defined in .env file');
  process.exit(1);
}

// ============================================================
// Discord Client 配置
// 新增了 GuildMembers Intent 用于获取身份组成员
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // 👈 必须开启此 Intent 才能读取身份组成员
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel]
});

// ============================================================
// 斜杠指令定义：/raffle
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName('raffle')
    .setDescription('从指定身份组中随机抽取若干成员并公布')
    .addRoleOption((option) =>
      option.setName('role').setDescription('要抽取的目标身份组').setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName('count').setDescription('抽取的人数').setRequired(true).setMinValue(1)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // 限制仅有管理服务器权限的人可使用
    .toJSON(),
];

// 注册斜杠指令函数
async function registerCommands() {
  if (!clientId) {
    console.warn('⚠️ DISCORD_CLIENT_ID 未设置，跳过斜杠指令注册。');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(token!);
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('✅ 已成功注册服务器专属斜杠指令');
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✅ 已注册全局斜杠指令（可能需要等待一段时间生效）');
    }
  } catch (error) {
    console.error('❌ 注册斜杠指令失败:', error);
  }
}

// 随机算法 (洗牌算法)
function pickRandom<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// ============================================================
// 事件监听
// ============================================================

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot is online! Logged in as ${c.user.tag}`);
  // 机器人上线后自动注册指令
  await registerCommands();
});

// 监听交互事件（处理斜杠指令）
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'raffle') {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: '❌ 该指令只能在服务器内使用。', ephemeral: true });
      return;
    }

    const role = interaction.options.getRole('role', true) as Role;
    const count = interaction.options.getInteger('count', true);

    // 延迟回复以防获取成员列表时超时 (超过3秒)
    await interaction.deferReply();

    try {
      // 强制拉取最新的服务器成员列表
      await guild.members.fetch();
      
      // 过滤出该身份组下所有非 Bot 的真实玩家
      const eligibleMembers = role.members.filter((m) => !m.user.bot);

      if (eligibleMembers.size === 0) {
        await interaction.editReply(`⚠️ 身份组 <@&${role.id}> 下没有找到任何成员（已排除机器人）。`);
        return;
      }

      // 如果要求的数量大于实际人数，则取最大实际人数
      const actualCount = Math.min(count, eligibleMembers.size);
      const winners = pickRandom([...eligibleMembers.values()], actualCount);

      // 组装提及 (@username) 的文本
      const mentions = winners.map((m) => `<@${m.id}>`).join(' ');

      await interaction.editReply(
        `🎉 **抽奖结果公布** 🎉\n从身份组 <@&${role.id}> 中随机抽取了 ${actualCount} 位成员：\n\n${mentions}`
      );
    } catch (error) {
      console.error('❌ /raffle 执行出错:', error);
      await interaction.editReply('❌ 抽奖执行过程中发生错误，请查看后台日志。');
    }
  }
});

// 监听消息事件（保留你原本的 n8n 转发逻辑）
client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return; 

  if (message.channel.isDMBased()) {
    console.log(`📩 Received DM from ${message.author.tag}: ${message.content}`);
    
    try {
      const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
      if (N8N_WEBHOOK_URL) {
        const body = {
          type: 'direct_message',
          userId: message.author.id,
          message: message.content
        };

        await fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
      } else {
        console.warn('N8N_WEBHOOK_URL is not defined in environment.');
      }

      console.log(`✉️ Replied to ${message.author.tag}`);
    } catch (error) {
      console.error('❌ Error sending reply:', error);
    }
  } else if (message.mentions.has(client.user!.id)) {
    console.log(`💬 Mentioned in channel by ${message.author.tag}: ${message.content}`);

    const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
    if (N8N_WEBHOOK_URL) {
      const body = {
        type: 'channel_mention',
        userId: message.author.id,
        message: message.content,
        channelId: message.channel.id,
      };

      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    } else {
      console.warn('N8N_WEBHOOK_URL is not defined in environment.');
    }
    
    try {
      console.log(`✉️ Replied to ${message.author.tag} in channel`);
    } catch (error) {
      console.error('❌ Error sending reply:', error);
    }
  }
});

client.login(token);
