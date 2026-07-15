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
  ButtonInteraction,
  ModalSubmitInteraction,
  Role,
  TextChannel,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  GuildMember,
} from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================
// 环境变量
// ============================================================
const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = '766274145922318367'; // 填了则注册为服务器指令，秒级生效

// 自动发码模式需要的 n8n webhook
const N8N_GET_CODES_URL = process.env.N8N_GET_CODES_URL; // 读取未使用礼包码
const N8N_MARK_CODE_USED_URL = process.env.N8N_MARK_CODE_USED_URL; // 标注礼包码已使用

// 手动 claim 模式需要的 n8n webhook
const N8N_RECORD_CLAIM_URL = process.env.N8N_RECORD_CLAIM_URL; // 记录玩家提交的 UID/Region/Server

// 自动发码失败时，通知这些管理员（逗号分隔的用户 ID）
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!token) {
  console.error('❌ Error: DISCORD_BOT_TOKEN is not defined in .env file');
  process.exit(1);
}

// ============================================================
// Discord Client
// 需要 GuildMembers Intent（读取角色成员 / 赋予身份组）
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

const DISCORD_MESSAGE_LIMIT = 2000;

// 记录已经提交过 claim 表单的用户，防止重复提交覆盖记录
// 注意：仅存于内存，机器人重启后会丢失，建议 n8n 侧也做一次幂等校验
const claimedUsers = new Set<string>();

// ============================================================
// 斜杠指令定义：/raffle
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName('raffle')
    .setDescription('从指定身份组中随机抽取若干成员，公布中奖名单并发放奖励')
    .addRoleOption((option) =>
      option.setName('role').setDescription('抽取范围：目标身份组').setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName('count').setDescription('抽取人数').setRequired(true).setMinValue(1)
    )
    .addRoleOption((option) =>
      option
        .setName('winner_role')
        .setDescription('中奖后要赋予的身份组')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('reward_mode')
        .setDescription('发奖方式')
        .setRequired(true)
        .addChoices(
          { name: '手动领取（玩家点击按钮 -> 填表单）', value: 'claim' },
          { name: '自动发放（bot 私信礼包码）', value: 'auto' }
        )
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
        .setDescription('自定义公布文案，可用 {count} / {role} 占位符')
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
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
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
// 工具函数
// ============================================================
function pickRandom<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

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
  if (current.length > 0) messages.push(current);
  return messages;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWebhook<T = any>(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs = 15000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`n8n webhook 返回状态码 ${res.status}: ${await res.text()}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  } finally {
    clearTimeout(timer);
  }
}

function mapDmErrorToReason(error: any): string {
  const code = error?.code ?? error?.rawError?.code;
  switch (code) {
    case 50007:
      return '对方关闭了私信权限或已屏蔽机器人';
    default:
      return error?.message ? `发送失败：${error.message}` : '未知错误，发送失败';
  }
}

// 按钮 / 弹窗的 custom_id 编码规则：把 winnerRoleId 编进去，方便后续按钮点击时校验身份组
const CLAIM_BUTTON_PREFIX = 'claim_reward__';
const CLAIM_MODAL_PREFIX = 'claim_modal__';

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
  const winnerRole = interaction.options.getRole('winner_role', true) as Role;
  const rewardMode = interaction.options.getString('reward_mode', true) as 'claim' | 'auto';
  const targetChannel =
    (interaction.options.getChannel('channel') as TextChannel | null) ??
    (interaction.channel as TextChannel);
  const customMessage = interaction.options.getString('message');

  if (!targetChannel || !targetChannel.isTextBased()) {
    await interaction.reply({ content: '❌ 目标频道无效或不是文字频道。', ephemeral: true });
    return;
  }

  if (rewardMode === 'auto' && (!N8N_GET_CODES_URL || !N8N_MARK_CODE_USED_URL)) {
    await interaction.reply({
      content: '❌ 自动发放模式需要的 n8n webhook 未配置完整，请联系开发者。',
      ephemeral: true,
    });
    return;
  }
  if (rewardMode === 'claim' && !N8N_RECORD_CLAIM_URL) {
    await interaction.reply({
      content: '❌ 手动领取模式需要的 n8n webhook 未配置完整，请联系开发者。',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await guild.members.fetch();
    const eligibleMembers = role.members.filter((m) => !m.user.bot);

    if (eligibleMembers.size === 0) {
      await interaction.editReply(`⚠️ 身份组 <@&${role.id}> 下没有找到任何成员（已排除机器人）。`);
      return;
    }

    const actualCount = Math.min(count, eligibleMembers.size);
    const winners = pickRandom([...eligibleMembers.values()], actualCount);

    // Step 1：给中奖者赋予 winner_role
    const roleAssignFailed: string[] = [];
    for (const winner of winners) {
      try {
        await winner.roles.add(winnerRole);
      } catch (error) {
        console.error(`❌ 给 ${winner.user.tag} 赋予身份组失败:`, error);
        roleAssignFailed.push(winner.user.tag);
      }
    }

    // Step 2：公布中奖名单
    const template =
      customMessage && customMessage.trim().length > 0
        ? customMessage
        : '🎉 恭喜以下 {count} 位「{role}」成员被抽中：';
    const header = template
      .replace(/{count}/g, String(actualCount))
      .replace(/{role}/g, role.name);

    const mentionList = winners.map((m) => `<@${m.id}>`);
    const messages = chunkMentions(header, mentionList);

    // 只在 claim 模式下，给最后一条公告消息附加"Claim"按钮
    const claimButtonRow =
      rewardMode === 'claim'
        ? new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`${CLAIM_BUTTON_PREFIX}${winnerRole.id}`)
              .setLabel('Claim')
              .setStyle(ButtonStyle.Success)
          )
        : null;

    for (let i = 0; i < messages.length; i++) {
      const isLast = i === messages.length - 1;
      await targetChannel.send({
        content: messages[i],
        components: isLast && claimButtonRow ? [claimButtonRow] : [],
      });
    }

    // Step 3：如果是自动发放模式，立即逐一私信礼包码
    let autoSendSummary = '';
    if (rewardMode === 'auto') {
      autoSendSummary = await sendAutoRewards(winners);
    }

    const roleFailNote =
      roleAssignFailed.length > 0
        ? `\n⚠️ 以下成员赋予身份组失败（可能是身份组层级问题）：${roleAssignFailed.join(', ')}`
        : '';

    await interaction.editReply(
      `✅ 已在 <#${targetChannel.id}> 公布抽取结果，共 ${actualCount} 人。${roleFailNote}${
        autoSendSummary ? `\n\n${autoSendSummary}` : ''
      }`
    );
  } catch (error) {
    console.error('❌ /raffle 执行出错:', error);
    await interaction.editReply('❌ 执行过程中发生错误，请查看后台日志。');
  }
}

// ============================================================
// 自动发放模式：逐一读取礼包码并私信给中奖者
// ============================================================
async function sendAutoRewards(winners: GuildMember[]): Promise<string> {
  const codesResponse = await callWebhook<{ codes: { rowId: string; code: string }[] }>(
    N8N_GET_CODES_URL!,
    { type: 'get_unused_codes', count: winners.length }
  );
  const availableCodes = codesResponse?.codes ?? [];

  if (availableCodes.length === 0) {
    return '❌ 礼包码文档中没有可用的未使用礼包码，自动发放已跳过。';
  }

  const insufficient = availableCodes.length < winners.length;
  const sendCount = Math.min(availableCodes.length, winners.length);

  let successCount = 0;
  const failedWinners: { member: GuildMember; reason: string }[] = [];

  for (let i = 0; i < sendCount; i++) {
    const winner = winners[i];
    const codeRow = availableCodes[i];

    try {
      await winner.send(
        `🎁 恭喜你获得专属礼包码：\n\`${codeRow.code}\`\n\n请妥善保管，如有问题请联系管理员。`
      );
      await callWebhook(N8N_MARK_CODE_USED_URL!, {
        type: 'mark_code_used',
        rowId: codeRow.rowId,
        code: codeRow.code,
        userId: winner.id,
      });
      successCount++;
    } catch (error) {
      const reason = mapDmErrorToReason(error);
      failedWinners.push({ member: winner, reason });
      // 注意：该码未标记为已使用，下次读取仍会出现在"未使用"池子里
    }

    await sleep(1200); // 简单限速，降低触发 Discord DM 速率限制的风险
  }

  // 发送失败的，私信通知管理员及时跟进
  if (failedWinners.length > 0 && ADMIN_USER_IDS.length > 0) {
    const failList = failedWinners
      .map((f) => `- ${f.member.user.tag}（${f.member.id}）：${f.reason}`)
      .join('\n');
    for (const adminId of ADMIN_USER_IDS) {
      try {
        const adminUser = await client.users.fetch(adminId);
        await adminUser.send(
          `⚠️ 以下用户奖励发送失败，请及时跟进：\n${failList}`
        );
      } catch (error) {
        console.error(`❌ 无法私信管理员 ${adminId}:`, error);
      }
    }
  } else if (failedWinners.length > 0) {
    console.warn('⚠️ 有发送失败的用户，但未配置 ADMIN_USER_IDS，无法私信通知管理员。');
  }

  let summary = `📤 自动发放结果：成功 ${successCount} 个，失败 ${failedWinners.length} 个。`;
  if (insufficient) {
    summary += `\n⚠️ 礼包码不足，还有 ${winners.length - sendCount} 名中奖者未处理。`;
  }
  return summary;
}

// ============================================================
// 按钮点击：Claim
// ============================================================
async function handleClaimButton(interaction: ButtonInteraction) {
  const winnerRoleId = interaction.customId.replace(CLAIM_BUTTON_PREFIX, '');
  const member = interaction.member as GuildMember;

  const hasRole = member.roles.cache.has(winnerRoleId);
  if (!hasRole) {
    await interaction.reply({
      content: "there's no reward available, good luck next time",
      ephemeral: true,
    });
    return;
  }

  if (claimedUsers.has(interaction.user.id)) {
    await interaction.reply({
      content: 'You have already submitted your info, please wait for the reward.',
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${CLAIM_MODAL_PREFIX}${winnerRoleId}`)
    .setTitle('Claim Your Reward');

  const uidInput = new TextInputBuilder()
    .setCustomId('uid')
    .setLabel('UID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const regionInput = new TextInputBuilder()
    .setCustomId('region')
    .setLabel('Region')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const serverInput = new TextInputBuilder()
    .setCustomId('server')
    .setLabel('Server')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(uidInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(regionInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(serverInput)
  );

  await interaction.showModal(modal);
}

// ============================================================
// 弹窗提交：记录 UID / Region / Server
// ============================================================
async function handleClaimModalSubmit(interaction: ModalSubmitInteraction) {
  const uid = interaction.fields.getTextInputValue('uid');
  const region = interaction.fields.getTextInputValue('region');
  const server = interaction.fields.getTextInputValue('server');

  try {
    if (N8N_RECORD_CLAIM_URL) {
      await callWebhook(N8N_RECORD_CLAIM_URL, {
        type: 'record_claim',
        userId: interaction.user.id,
        username: interaction.user.tag,
        uid,
        region,
        server,
        submittedAt: new Date().toISOString(),
      });
    }
    claimedUsers.add(interaction.user.id);

    await interaction.reply({
      content: 'your info has been recorded, rewards will be sent soon, pls wait',
      ephemeral: true,
    });
  } catch (error) {
    console.error('❌ 记录 claim 信息失败:', error);
    await interaction.reply({
      content: '❌ 提交失败，请稍后重试或联系管理员。',
      ephemeral: true,
    });
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
  if (interaction.isChatInputCommand() && interaction.commandName === 'raffle') {
    await handleRaffleCommand(interaction);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith(CLAIM_BUTTON_PREFIX)) {
    await handleClaimButton(interaction);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(CLAIM_MODAL_PREFIX)) {
    await handleClaimModalSubmit(interaction);
    return;
  }
});

client.login(token);
