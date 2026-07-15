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
  Role,
  GuildMember
} from 'discord.js';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID; // 填了则注册为服务器指令，秒级生效

// n8n Webhook 接口配置
const N8N_GET_CODES_URL = process.env.N8N_GET_CODES_URL;       // n8n 获取未发放礼包码接口
const N8N_UPDATE_CODES_URL = process.env.N8N_UPDATE_CODES_URL; // n8n 标记成功并发放时间接口

if (!token) {
  console.error('❌ Error: DISCORD_BOT_TOKEN is not defined in .env file');
  process.exit(1);
}

// ============================================================
// Discord Client 配置
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // 必须开启
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
    .setDescription('从指定身份组中随机抽取若干成员，并通过私信自动发放飞书礼包码')
    .addRoleOption((option) =>
      option.setName('role').setDescription('要抽取的目标身份组').setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName('count').setDescription('抽取的人数').setRequired(true).setMinValue(1)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // 仅限管理员使用
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

// 随机算法（洗牌算法）
function pickRandom<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// 延时函数
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// 事件监听
// ============================================================

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot is online! Logged in as ${c.user.tag}`);
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

    if (!N8N_GET_CODES_URL || !N8N_UPDATE_CODES_URL) {
      await interaction.reply({ 
        content: '❌ 未在环境变量中配置 N8N_GET_CODES_URL 或 N8N_UPDATE_CODES_URL，请先进行配置。', 
        ephemeral: true 
      });
      return;
    }

    const role = interaction.options.getRole('role', true) as Role;
    const count = interaction.options.getInteger('count', true);

    // 预先回复，防止网关请求和飞书交互超时
    await interaction.deferReply();

    try {
      // 1. 强制拉取最新的服务器成员列表，显式设置 20s 超时
      const fetchedMembers = await guild.members.fetch({ time: 20000 });
      
      // 过滤出目标身份组下的真实用户（排除 Bot）
      const eligibleMembers = fetchedMembers.filter(
        (member) => member.roles.cache.has(role.id) && !member.user.bot
      );

      if (eligibleMembers.size === 0) {
        await interaction.editReply(`⚠️ 身份组 <@&${role.id}> 下没有找到任何成员（已排除机器人）。`);
        return;
      }

      const actualCount = Math.min(count, eligibleMembers.size);
      const winners = pickRandom([...eligibleMembers.values()], actualCount);

      // 2. 请求 n8n 从飞书表格拉取对应数量的未使用礼包码（状态不为 1）
      const codesResponse = await fetch(N8N_GET_CODES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: actualCount })
      });

      if (!codesResponse.ok) {
        throw new Error(`n8n 礼包码获取接口返回错误: ${codesResponse.statusText}`);
      }

      const data = await codesResponse.json() as { codes?: { rowId: string; code: string }[] };
      const availableCodes = data.codes ?? [];

      if (availableCodes.length === 0) {
        await interaction.editReply('⚠️ 未能从飞书文档中获取到可用的未使用礼包码，发放终止。');
        return;
      }

      const sendCount = Math.min(winners.length, availableCodes.length);
      const successResults: { rowId: string; code: string; userId: string; status: 'success' }[] = [];
      const failedMembers: GuildMember[] = []; // 记录因私信关闭导致发送失败的玩家

      // 3. 逐个进行私信发放
      for (let i = 0; i < sendCount; i++) {
        const winner = winners[i];
        const codeInfo = availableCodes[i];

        try {
          // 私信玩家
          await winner.send(
            `🎉 恭喜你在本次活动抽奖中被抽中！\n这是你的专属礼包码：\n\`${codeInfo.code}\`\n\n请尽快在游戏内兑换。`
          );

          // 记录发送成功的数据，用于后续通知 n8n 更新飞书状态
          successResults.push({
            rowId: codeInfo.rowId,
            code: codeInfo.code,
            userId: winner.id,
            status: 'success'
          });
        } catch (error: any) {
          console.warn(`📩 无法私信玩家 ${winner.user.tag} (ID: ${winner.id}), 错误码: ${error.code}`);
          // 如果因关闭私信（Discord Code: 50007）或其他原因失败，归入失败数组
          failedMembers.push(winner);
        }

        // 适当延时，避免触发 Discord 速率限制
        await sleep(1000);
      }

      // 4. 将发放成功的记录批量推送给 n8n（让 n8n 在飞书第二列标注 1，第三列记录发送时间）
      if (successResults.length > 0) {
        await fetch(N8N_UPDATE_CODES_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ results: successResults })
        });
      }

      // 5. 拼接频道内的最终播报文本
      const successMentions = winners
        .filter(w => !failedMembers.includes(w))
        .map((m) => `<@${m.id}>`)
        .join(' ');

      let replyContent = `🎉 **抽奖及自动发码结果** 🎉\n\n`;
      
      if (successResults.length > 0) {
        replyContent += `✅ **以下玩家已成功私信发放礼包码：**\n${successMentions}\n\n`;
      }

      // 如果有发送失败的玩家，将其 mention 出来并提示
      if (failedMembers.length > 0) {
        const failedMentions = failedMembers.map((m) => `<@${m.id}>`).join(' ');
        replyContent += `⚠️ **以下玩家因关闭了私信导致发送失败：**\n${failedMentions}\n👉 **请开启服务器私信权限，并主动联系 Admin 补领奖励！**\n\n`;
      }

      if (availableCodes.length < actualCount) {
        replyContent += `💡 *提示：因飞书库存礼包码不足（缺 ${actualCount - availableCodes.length} 个），部分抽取到的玩家未能分配。*`;
      }

      await interaction.editReply(replyContent);

    } catch (error) {
      console.error('❌ /raffle 执行出错:', error);
      await interaction.editReply('❌ 抽奖执行过程中发生错误，请查看后台日志。');
    }
  }
});

// 监听消息事件（保留原 n8n 转发逻辑）
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
          headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
