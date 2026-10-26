import type {
  MediaMessageContent,
  MessageContent,
  MessageFormField,
  MessageOption,
  QuestionMessageContent,
  ResultCardMessageContent,
  VisualizationMessageContent,
  VoiceMessageContent
} from '../shared/contracts';

export const CHAT_UI_TOOL_NAMESPACE = 'rambo_chat_ui';

export const CHAT_UI_TOOLS = {
  type: 'namespace',
  name: CHAT_UI_TOOL_NAMESPACE,
  description: '在用户可见的 Rambo Bot 聊天中展示结构化内容。普通文字继续自由回复；只有需要用户选择时才用问题卡。',
  tools: [{
    type: 'function',
    name: 'ask_question',
    description: '当用户需要选择、确认或填写自定义答案时展示可交互问题卡。选项会作为按钮展示；可选允许多选或自定义答案。卡片会保留到用户回答，回答自动回到当前 Bot。不要用普通 Markdown 列表代替需要交互的问题。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '展示在问题卡顶部的问题。' },
        options: {
          type: 'array', minItems: 2, maxItems: 12,
          items: {
            type: 'object', properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              description: { type: 'string' }
            }, required: ['label'], additionalProperties: false
          }
        },
        allowMultiple: { type: 'boolean', description: '允许用户选择多个选项。' },
        allowCustom: { type: 'boolean', description: '允许用户在聊天输入框中提交自定义文字。' },
        customPlaceholder: { type: 'string' }
      },
      required: ['prompt', 'options'], additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'show_content',
    description: '在聊天区展示结构化结果、工作流/表单卡片、媒体或音频行、MCP 嵌入应用、数据可视化。媒体 URL 可使用 HTTP(S) 或当前 Bot 工作区内的相对/绝对文件路径；路径只允许读取当前 Bot 工作区。根据内容选择 kind；需要用户动作时提供 actions 或 formFields，用户提交后答案回到当前 Bot。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['card', 'media', 'voice', 'mcp_embed', 'visualization'] },
        template: { type: 'string', enum: ['generic', 'weather', 'shopping', 'form', 'approval', 'connector', 'email', 'calendar'] },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        summary: { type: 'string' },
        fields: {
          type: 'array', maxItems: 20,
          items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'], additionalProperties: false }
        },
        sections: {
          type: 'array', maxItems: 20,
          items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['body'], additionalProperties: false }
        },
        items: {
          type: 'array', maxItems: 50,
          items: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, metadata: { type: 'string' }, imageUrl: { type: 'string' } }, required: ['title'], additionalProperties: false }
        },
        actions: {
          type: 'array', maxItems: 12,
          items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, description: { type: 'string' } }, required: ['label'], additionalProperties: false }
        },
        formFields: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', properties: {
              name: { type: 'string' }, label: { type: 'string' },
              type: { type: 'string', enum: ['text', 'textarea', 'email', 'number', 'date', 'select', 'checkbox'] },
              placeholder: { type: 'string' }, required: { type: 'boolean' }, options: { type: 'array', items: { type: 'string' } }
            }, required: ['name', 'label', 'type'], additionalProperties: false
          }
        },
        mediaType: { type: 'string', enum: ['image', 'video', 'audio', 'file'] },
        url: { type: 'string' },
        alt: { type: 'string' },
        caption: { type: 'string' },
        mimeType: { type: 'string' },
        transcript: { type: 'string' },
        speaker: { type: 'string' },
        durationSeconds: { type: 'number', minimum: 0 },
        appName: { type: 'string' },
        chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'table'] },
        labels: { type: 'array', items: { type: 'string' } },
        series: {
          type: 'array', maxItems: 12,
          items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'], additionalProperties: false }
        },
        unit: { type: 'string' }
      },
      required: ['kind'], additionalProperties: false
    }
  }]
};

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内容参数必须是对象');
  return value as RecordValue;
};
const asText = (value: unknown, name: string, max = 12_000, required = false): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(`${name} 格式无效`);
  }
  return value;
};
const asList = (value: unknown, name: string, max: number): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} 格式无效`);
  return value;
};
const asOption = (value: unknown): MessageOption => {
  if (typeof value === 'string') return { label: value };
  const option = asRecord(value);
  return {
    label: asText(option.label, '选项名称', 200, true)!,
    ...(asText(option.value, '选项值', 2_000) !== undefined ? { value: option.value as string } : {}),
    ...(asText(option.description, '选项说明', 1_000) !== undefined ? { description: option.description as string } : {})
  };
};
const safeWebUrl = (value: unknown, name = 'URL'): string => {
  const url = asText(value, name, 8_000, true)!;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${name} 格式无效`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${name} 只支持 HTTP 或 HTTPS 地址`);
  return parsed.toString();
};
const safeMediaReference = (value: unknown, name = 'URL'): string => {
  const source = asText(value, name, 8_000, true)!;
  try {
    const parsed = new URL(source);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
    if (parsed.protocol === 'file:') return source;
    throw new Error(`${name} 只支持 HTTP、HTTPS 或 Bot 工作区文件`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('只支持')) throw error;
    if (/^[a-z][a-z\d+.-]*:/iu.test(source)) throw new Error(`${name} 只支持 HTTP、HTTPS 或 Bot 工作区文件`);
    return source;
  }
};
const asFormField = (value: unknown): MessageFormField => {
  const field = asRecord(value);
  const validTypes = ['text', 'textarea', 'email', 'number', 'date', 'select', 'checkbox'] as const;
  if (!validTypes.includes(field.type as typeof validTypes[number])) throw new Error('表单字段类型无效');
  const options = asList(field.options, '表单选项', 50).map(option => asText(option, '表单选项', 200, true)!);
  return {
    name: asText(field.name, '表单字段名', 100, true)!,
    label: asText(field.label, '表单字段标签', 200, true)!,
    type: field.type as MessageFormField['type'],
    ...(asText(field.placeholder, '表单占位文字', 500) !== undefined ? { placeholder: field.placeholder as string } : {}),
    ...(field.required !== undefined ? { required: field.required === true } : {}),
    ...(options.length ? { options } : {})
  };
};

export function buildQuestionContent(input: unknown): { content: QuestionMessageContent; text: string } {
  const value = asRecord(input);
  const prompt = asText(value.prompt, '问题', 8_000, true)!;
  const options = asList(value.options, '问题选项', 12).map(asOption);
  if (options.length < 2) throw new Error('问题至少需要两个选项');
  const allowMultiple = value.allowMultiple === true;
  const allowCustom = value.allowCustom === true;
  const content: QuestionMessageContent = {
    kind: 'question', prompt, options, allowMultiple, allowCustom,
    ...(asText(value.customPlaceholder, '自定义答案提示', 300) !== undefined
      ? { customPlaceholder: value.customPlaceholder as string }
      : {}),
    state: 'pending'
  };
  return { content, text: prompt };
}

export function buildDisplayContent(input: unknown): { content: MessageContent; text: string } {
  const value = asRecord(input);
  const kind = value.kind;
  if (kind === 'media') {
    const mediaType = value.mediaType;
    if (!['image', 'video', 'audio', 'file'].includes(String(mediaType))) throw new Error('媒体类型无效');
    const content: MediaMessageContent = {
      kind: 'media', mediaType: mediaType as MediaMessageContent['mediaType'], url: safeMediaReference(value.url),
      ...(asText(value.title, '标题', 300) !== undefined ? { title: value.title as string } : {}),
      ...(asText(value.alt, '替代文字', 1_000) !== undefined ? { alt: value.alt as string } : {}),
      ...(asText(value.caption, '说明', 2_000) !== undefined ? { caption: value.caption as string } : {}),
      ...(asText(value.mimeType, '媒体 MIME 类型', 200) !== undefined ? { mimeType: value.mimeType as string } : {})
    };
    return { content, text: content.title ?? content.caption ?? content.alt ?? content.url };
  }
  if (kind === 'voice') {
    const content: VoiceMessageContent = {
      kind: 'voice', transcript: asText(value.transcript, '语音转写', 12_000) ?? '',
      ...(value.url !== undefined ? { audioUrl: safeMediaReference(value.url) } : {}),
      ...(asText(value.speaker, '说话者', 200) !== undefined ? { speaker: value.speaker as string } : {}),
      ...(typeof value.durationSeconds === 'number' && Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0
        ? { durationSeconds: Math.min(value.durationSeconds, 86_400) }
        : {})
    };
    if (!content.transcript && !content.audioUrl) throw new Error('语音行需要转写文字或音频地址');
    return { content, text: content.transcript || content.speaker || '语音消息' };
  }
  if (kind === 'mcp_embed') {
    const content = {
      kind: 'mcp_embed' as const,
      appName: asText(value.appName, '应用名称', 200, true)!,
      ...(asText(value.title, '标题', 300) !== undefined ? { title: value.title as string } : {}),
      ...(asText(value.summary ?? value.description, '应用说明', 4_000) !== undefined
        ? { description: (value.summary ?? value.description) as string }
        : {}),
      url: safeWebUrl(value.url)
    };
    return { content, text: content.title ?? content.description ?? content.appName };
  }
  if (kind === 'visualization') {
    const chartType = value.chartType;
    if (!['bar', 'line', 'pie', 'table'].includes(String(chartType))) throw new Error('图表类型无效');
    const labels = asList(value.labels, '图表标签', 200).map(label => asText(label, '图表标签', 200, true)!);
    const series = asList(value.series, '图表数据', 12).map(raw => {
      const row = asRecord(raw);
      const values = asList(row.values, '图表数值', 200).map(item => {
        if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('图表数值无效');
        return item;
      });
      return { name: asText(row.name, '数据系列名称', 200, true)!, values };
    });
    if (series.some(item => item.values.length !== labels.length)) throw new Error('图表标签和数据数量不一致');
    if (chartType !== 'table' && (!labels.length || !series.length)) throw new Error('图表至少需要一个标签和数据系列');
    const content: VisualizationMessageContent = {
      kind: 'visualization', chartType: chartType as VisualizationMessageContent['chartType'],
      ...(asText(value.title, '图表标题', 300) !== undefined ? { title: value.title as string } : {}),
      labels, series,
      ...(asText(value.unit, '图表单位', 80) !== undefined ? { unit: value.unit as string } : {})
    };
    return { content, text: content.title ?? '数据可视化' };
  }
  if (kind !== 'card') throw new Error('内容类型不受支持');

  const template = value.template ?? 'generic';
  if (!['generic', 'weather', 'shopping', 'form', 'approval', 'connector', 'email', 'calendar'].includes(String(template))) {
    throw new Error('卡片模板无效');
  }
  const fields = asList(value.fields, '卡片字段', 20).map(raw => {
    const field = asRecord(raw);
    return { label: asText(field.label, '字段名称', 200, true)!, value: asText(field.value, '字段内容', 4_000, true)! };
  });
  const sections = asList(value.sections, '卡片分区', 20).map(raw => {
    const section = asRecord(raw);
    return {
      ...(asText(section.title, '分区标题', 200) !== undefined ? { title: section.title as string } : {}),
      body: asText(section.body, '分区内容', 8_000, true)!
    };
  });
  const items = asList(value.items, '卡片项目', 50).map(raw => {
    const item = asRecord(raw);
    return {
      title: asText(item.title, '项目标题', 300, true)!,
      ...(asText(item.description, '项目说明', 2_000) !== undefined ? { description: item.description as string } : {}),
      ...(asText(item.metadata, '项目元数据', 1_000) !== undefined ? { metadata: item.metadata as string } : {}),
      ...(item.imageUrl !== undefined ? { imageUrl: safeMediaReference(item.imageUrl, '项目图片地址') } : {})
    };
  });
  const actions = asList(value.actions, '卡片操作', 12).map(asOption);
  const formFields = asList(value.formFields, '表单字段', 20).map(asFormField);
  const content: ResultCardMessageContent = {
    kind: 'card', template: template as ResultCardMessageContent['template'],
    title: asText(value.title, '标题', 300, true)!,
    ...(asText(value.subtitle, '副标题', 500) !== undefined ? { subtitle: value.subtitle as string } : {}),
    ...(asText(value.summary, '摘要', 4_000) !== undefined ? { summary: value.summary as string } : {}),
    ...(fields.length ? { fields } : {}), ...(sections.length ? { sections } : {}),
    ...(items.length ? { items } : {}), ...(actions.length ? { actions } : {}),
    ...(formFields.length ? { formFields } : {}),
    ...(actions.length || formFields.length ? { state: 'pending' as const } : {})
  };
  if (JSON.stringify(content).length > 60_000) throw new Error('卡片内容过长');
  return { content, text: content.summary ?? content.title };
}
