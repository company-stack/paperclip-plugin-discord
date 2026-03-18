import type { PluginContext } from "@paperclipai/plugin-sdk";
import { type DiscordEmbed, postEmbed, respondToInteraction } from "./discord-api.js";
import { COLORS, DISCORD_API_BASE } from "./constants.js";

interface InteractionOption {
  name: string;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

interface AcpInteractionData {
  options?: InteractionOption[];
}

interface AcpOutputEvent {
  sessionId: string;
  channelId: string;
  threadId: string;
  agentName: string;
  output: string;
  status?: "running" | "completed" | "failed";
}

interface AcpBinding {
  sessionId: string;
  agentName: string;
  channelId: string;
  threadId: string;
  startedAt: string;
  status: "running" | "completed" | "failed" | "cancelled";
}

function getOption(
  options: InteractionOption[] | undefined,
  name: string,
): string | undefined {
  return options
    ?.find((o) => o.name === name)
    ?.value?.toString();
}

async function getBinding(
  ctx: PluginContext,
  threadId: string,
): Promise<AcpBinding | null> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: "default",
    stateKey: `acp_binding_${threadId}`,
  });
  return (raw as AcpBinding) ?? null;
}

async function saveBinding(
  ctx: PluginContext,
  threadId: string,
  binding: AcpBinding,
): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: "default",
      stateKey: `acp_binding_${threadId}`,
    },
    binding,
  );
}

export async function handleAcpCommand(
  ctx: PluginContext,
  data: AcpInteractionData,
): Promise<unknown> {
  const subcommand = data.options?.[0];
  if (!subcommand) {
    return respondToInteraction({
      type: 4,
      content: "Missing subcommand. Try `/acp spawn agent:<name> task:<description>`.",
      ephemeral: true,
    });
  }

  const subName = subcommand.name;

  switch (subName) {
    case "spawn":
      return handleAcpSpawn(ctx, subcommand.options);
    case "status":
      return handleAcpStatus(ctx, subcommand.options);
    case "cancel":
      return handleAcpCancel(ctx, subcommand.options);
    case "close":
      return handleAcpClose(ctx, subcommand.options);
    default:
      return respondToInteraction({
        type: 4,
        content: `Unknown ACP subcommand: ${subName}`,
        ephemeral: true,
      });
  }
}

async function handleAcpSpawn(
  ctx: PluginContext,
  options: InteractionOption[] | undefined,
): Promise<unknown> {
  const agentName = getOption(options, "agent");
  const task = getOption(options, "task");

  if (!agentName || !task) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/acp spawn agent:<name> task:<description>`",
      ephemeral: true,
    });
  }

  const sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  ctx.events.emit("acp:message", {
    type: "spawn",
    sessionId,
    agentName,
    task,
  });

  ctx.logger.info("ACP session spawn requested", { sessionId, agentName, task });

  return respondToInteraction({
    type: 4,
    content: `Spawning agent **${agentName}** for task:\n> ${task}\n\nSession: \`${sessionId}\`\nA thread will be created when the agent starts producing output.`,
    ephemeral: false,
  });
}

async function handleAcpStatus(
  ctx: PluginContext,
  options: InteractionOption[] | undefined,
): Promise<unknown> {
  const sessionId = getOption(options, "session");

  if (!sessionId) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/acp status session:<session-id>`",
      ephemeral: true,
    });
  }

  ctx.events.emit("acp:message", {
    type: "status",
    sessionId,
  });

  return respondToInteraction({
    type: 4,
    content: `Checking status for session \`${sessionId}\`...`,
    ephemeral: true,
  });
}

async function handleAcpCancel(
  ctx: PluginContext,
  options: InteractionOption[] | undefined,
): Promise<unknown> {
  const sessionId = getOption(options, "session");

  if (!sessionId) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/acp cancel session:<session-id>`",
      ephemeral: true,
    });
  }

  ctx.events.emit("acp:message", {
    type: "cancel",
    sessionId,
  });

  ctx.logger.info("ACP session cancel requested", { sessionId });

  return respondToInteraction({
    type: 4,
    content: `Cancelling session \`${sessionId}\`...`,
    ephemeral: false,
  });
}

async function handleAcpClose(
  ctx: PluginContext,
  options: InteractionOption[] | undefined,
): Promise<unknown> {
  const sessionId = getOption(options, "session");

  if (!sessionId) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/acp close session:<session-id>`",
      ephemeral: true,
    });
  }

  ctx.events.emit("acp:message", {
    type: "close",
    sessionId,
  });

  ctx.logger.info("ACP session close requested", { sessionId });

  return respondToInteraction({
    type: 4,
    content: `Closing session \`${sessionId}\`. The thread will be archived.`,
    ephemeral: false,
  });
}

export async function routeMessageToAcp(
  ctx: PluginContext,
  channelId: string,
  threadId: string,
  text: string,
): Promise<boolean> {
  const binding = await getBinding(ctx, threadId);
  if (!binding) return false;

  if (binding.status !== "running") {
    ctx.logger.info("Ignoring message for non-running ACP session", {
      threadId,
      status: binding.status,
    });
    return false;
  }

  ctx.events.emit("acp:message", {
    type: "message",
    sessionId: binding.sessionId,
    channelId,
    threadId,
    text,
  });

  return true;
}

export async function handleAcpOutput(
  ctx: PluginContext,
  token: string,
  event: AcpOutputEvent,
): Promise<void> {
  const { sessionId, channelId, threadId, agentName, output, status } = event;

  // Ensure a thread exists and binding is stored
  let binding = await getBinding(ctx, threadId);
  if (!binding) {
    binding = {
      sessionId,
      agentName,
      channelId,
      threadId,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    await saveBinding(ctx, threadId, binding);
  }

  // Update status if provided
  if (status && status !== binding.status) {
    binding.status = status;
    await saveBinding(ctx, threadId, binding);
  }

  // Format the output as a Discord message with code blocks and embed
  const embeds: DiscordEmbed[] = [];
  const statusColor = status === "completed"
    ? COLORS.GREEN
    : status === "failed"
      ? COLORS.RED
      : COLORS.BLUE;

  const truncatedOutput = output.length > 1900
    ? output.slice(0, 1900) + "\n... (truncated)"
    : output;

  const content = `\`\`\`\n${truncatedOutput}\n\`\`\``;

  if (status === "completed" || status === "failed") {
    embeds.push({
      title: status === "completed" ? "Agent Completed" : "Agent Failed",
      description: `**${agentName}** session \`${sessionId}\` ${status}.`,
      color: statusColor,
      footer: { text: "Paperclip ACP" },
      timestamp: new Date().toISOString(),
    });
  }

  const message = {
    content,
    embeds: embeds.length > 0 ? embeds : undefined,
  };

  const delivered = await postEmbed(ctx, token, threadId, message);
  if (delivered) {
    ctx.logger.info("ACP output delivered to thread", { sessionId, threadId });
  }
}

export async function createAcpThread(
  ctx: PluginContext,
  token: string,
  channelId: string,
  agentName: string,
  task: string,
  sessionId: string,
): Promise<string | null> {
  const threadName = `${agentName}: ${task.slice(0, 80)}`;

  try {
    const response = await ctx.http.fetch(
      `${DISCORD_API_BASE}/channels/${channelId}/threads`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: threadName,
          type: 11, // PUBLIC_THREAD
          auto_archive_duration: 1440, // 24 hours
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      ctx.logger.warn("Failed to create ACP thread", {
        status: response.status,
        body: text,
        channelId,
      });
      return null;
    }

    const thread = (await response.json()) as { id: string };
    const threadId = thread.id;

    // Store the binding
    const binding: AcpBinding = {
      sessionId,
      agentName,
      channelId,
      threadId,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    await saveBinding(ctx, threadId, binding);

    // Post an initial message in the thread
    await postEmbed(ctx, token, threadId, {
      embeds: [
        {
          title: `Agent Session: ${agentName}`,
          description: `**Task:** ${task}\n**Session:** \`${sessionId}\``,
          color: COLORS.BLUE,
          footer: { text: "Paperclip ACP" },
          timestamp: new Date().toISOString(),
        },
      ],
    });

    ctx.logger.info("ACP thread created", { threadId, sessionId, agentName });
    return threadId;
  } catch (error) {
    ctx.logger.error("Failed to create ACP thread", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
