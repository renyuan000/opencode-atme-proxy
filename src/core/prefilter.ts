import type { IncomingMessage, PrefilterLayer, PrefilterResult } from "./types.js";

export interface PrefilterContext {
  ownerId?: string;
  botId?: string;
  ownerKeywords?: string[];
  coreProjects?: string[];
  referenceProjects?: string[];
  ownerDirection?: string;
}

const CORE_TERMS = [
  "npb-engine",
  "npb-transform",
  "engine",
  "transform",
  "流量采集",
  "采集",
  "协议解析",
  "协议识别",
  "解析",
  "抓包",
  "丢包",
  "pcap",
  "flow",
  "eve",
  "app-layer",
  "五元组",
];

const EXTERNAL_TERMS = [
  "平台",
  "管理平台",
  "资产台账",
  "台账",
  "前端",
  "页面",
  "界面",
  "浏览器",
  "门户",
  "导航",
  "按钮",
  "筛选项",
  "表格列",
  "联调",
  "web",
];

const PROTOCOL_TERMS = [
  "http",
  "https",
  "dns",
  "tls",
  "sip",
  "iec104",
  "modbus",
  "mqtt",
  "grpc",
  "应用层",
  "应用协议",
  "app-layer",
  "协议识别",
  "协议解析",
  "parser",
  "event_type",
];

const PERFORMANCE_TERMS = [
  "压测",
  "压力测试",
  "性能测试",
  "性能分析",
  "基准",
  "benchmark",
  "吞吐",
  "时延",
  "丢包",
  "cpu",
  "内存",
  "磁盘",
  "io",
  "pps",
  "带宽",
];

const KAFKA_TERMS = [
  "kafka",
  "topic",
  "partition",
  "offset",
  "consumer",
  "producer",
  "consumer lag",
  "消息队列",
  "消息链路",
];

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.git$/, "") ?? path;
}

function matches(text: string, terms: string[]): string[] {
  return [
    ...new Set(
      terms.filter((term) => {
        if (!term) return false;
        const value = term.toLowerCase();
        if (!/^[a-z0-9_-]+$/.test(value)) return text.includes(value);
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`).test(text);
      }),
    ),
  ];
}

function hasStrongExternal(text: string): boolean {
  return /平台|资产台账|台账|前端|页面|界面|浏览器|门户|管理平台|联调|web/.test(text);
}

export function prefilterMessage(
  message: IncomingMessage,
  context: PrefilterContext = {},
): PrefilterResult {
  const text = message.text.toLowerCase();
  const mentionIds = new Set(message.mentions.map((mention) => mention.id));
  const mentionedOwner = Boolean(context.ownerId && mentionIds.has(context.ownerId));
  const mentionedBot = Boolean(context.botId && mentionIds.has(context.botId));
  const addressedToOther =
    message.mentions.length > 0 && !mentionedOwner && !mentionedBot;

  const projectTerms = [
    ...(context.coreProjects ?? []).map(basename),
    ...(context.referenceProjects ?? []).map(basename),
  ];
  const ownerTerms = (context.ownerKeywords ?? []).filter(
    (term) => !EXTERNAL_TERMS.some((external) => term.toLowerCase().includes(external)),
  );
  const coreHits = matches(text, [...CORE_TERMS, ...projectTerms, ...ownerTerms]);
  const externalHits = matches(text, EXTERNAL_TERMS);
  const protocolHits = matches(text, PROTOCOL_TERMS);
  const performanceHit = matches(text, PERFORMANCE_TERMS).length > 0;
  const kafkaHit = matches(text, KAFKA_TERMS).length > 0;

  const layerHints = new Set<PrefilterLayer>();
  if (
    externalHits.some((hit) =>
      /前端|页面|界面|浏览器|门户|导航|按钮|筛选项|表格列|资产台账|台账|web/.test(hit),
    )
  ) {
    layerHints.add("web_ui");
  }
  if (externalHits.some((hit) => /平台|管理平台|联调/.test(hit))) layerHints.add("service");
  if (/sql|postgres|pg|数据库|表名|字段|慢查询|主键|索引/.test(text)) layerHints.add("pg");
  if (kafkaHit) layerHints.add("kafka");
  if (coreHits.length > 0 || /engine|采集|抓包|pcap|flow|eve/.test(text)) {
    layerHints.add("engine");
  }
  if (protocolHits.length > 0) layerHints.add("protocol");
  if (performanceHit) layerHints.add("performance");
  if (/安装|部署|systemd|配置|重启|122|245|打包/.test(text)) layerHints.add("deploy");

  let score = 0;
  if (coreHits.length > 0) score += Math.min(3, coreHits.length);
  if (mentionedOwner || mentionedBot) score += 2;
  if (addressedToOther) score -= 3;
  if (externalHits.length > 0) score -= Math.min(2, externalHits.length);
  if (protocolHits.length > 0 && (coreHits.length > 0 || /engine|采集|解析|app-layer/.test(text))) {
    score += 1;
  }
  if (kafkaHit && /npb|transform|流分|engine|采集/.test(text)) score += 2;
  if (performanceHit && coreHits.length > 0) score += 2;
  if (performanceHit && externalHits.length > 0 && coreHits.length === 0) score -= 1;

  const strongExternal =
    coreHits.length === 0 &&
    externalHits.length > 0 &&
    hasStrongExternal(text) &&
    !protocolHits.some((hit) => /协议|app-layer|parser|event_type/.test(hit));

  const reasons: string[] = [];
  if (addressedToOther) reasons.push("只 @ 了别人");
  if (mentionedOwner || mentionedBot) reasons.push("@ 了我/机器人");
  if (coreHits.length > 0) reasons.push(`命中核心信号：${coreHits.slice(0, 4).join("、")}`);
  if (externalHits.length > 0) reasons.push(`命中外部信号：${externalHits.slice(0, 4).join("、")}`);
  if (protocolHits.length > 0) reasons.push(`协议信号：${protocolHits.slice(0, 4).join("、")}`);
  if (performanceHit) reasons.push(coreHits.length > 0 ? "性能压测：核心目标" : "性能压测：目标待确认");
  if (kafkaHit) reasons.push("Kafka/消息链路");
  if (strongExternal) reasons.push("强外部候选");

  return {
    score,
    reasons,
    layerHints: [...layerHints],
    addressedToOther,
    mentionedOwner,
    mentionedBot,
    coreHits,
    externalHits,
    protocolHits,
    performanceHit,
    kafkaHit,
    strongExternal,
  };
}
