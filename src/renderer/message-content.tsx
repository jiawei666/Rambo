import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import './message-content.css';
import { isMessageContent } from '../shared/contracts';
import type {
  GroupMessage,
  Message,
  MessageContent,
  MessageFormField,
  MessageOption,
  QuestionMessageContent,
  ResultCardMessageContent,
  VisualizationMessageContent
} from '../shared/contracts';

type TranscriptMessage = Message | GroupMessage;

export function MessageContentView({ message }: { message: TranscriptMessage }) {
  const content = message.content;
  if (!content || !isMessageContent(content)) return <MarkdownBody messageId={message.id} text={message.text} />;
  switch (content.kind) {
    case 'question': return <QuestionCard messageId={message.id} content={content} />;
    case 'card': return <ResultCard messageId={message.id} content={content} />;
    case 'media': return <>
      {content.generated && message.text.trim() && <MarkdownBody messageId={message.id} text={message.text} />}
      <MediaContent
        messageId={message.id}
        content={content.generated ? { ...content, caption: undefined } : content}
      />
    </>;
    case 'voice': return <VoiceContent messageId={message.id} content={content} />;
    case 'mcp_embed': return <McpEmbed content={content} />;
    case 'visualization': return <Visualization content={content} />;
    default: return <MarkdownBody messageId={message.id} text={message.text} />;
  }
}

function MarkdownBody({ messageId, text }: { messageId: string; text: string }) {
  const components = useMemo(() => markdownComponents(messageId), [messageId]);
  return (
    <div className="transcript-markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={components}
        urlTransform={safeMarkdownUrl}
      >
        {text}
      </Markdown>
    </div>
  );
}

function markdownComponents(messageId: string): Components {
  return {
  a({ href, children, ...props }) {
    return <MarkdownLink messageId={messageId} href={href} title={plainText(children)} {...props}>{children}</MarkdownLink>;
  },
  img({ src, alt, title }) {
    if (!src) return null;
    return <ResolvedImage messageId={messageId} source={src} alt={alt ?? ''} title={title} />;
  },
  table({ children }) {
    return <div className="transcript-table-scroll" role="region" aria-label="可横向滚动的表格" tabIndex={0}><table>{children}</table></div>;
  },
  pre({ children }) {
    const child = Children.toArray(children).find(isValidElement) as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
    if (!child) return <pre>{children}</pre>;
    const className = child.props.className ?? '';
    const language = /language-([\w-]+)/u.exec(className)?.[1] ?? '';
    const codeText = plainText(child.props.children);
    if (language.toLocaleLowerCase() === 'mermaid') return <MermaidDiagram source={codeText} />;
    return <CodeBlock language={language} source={codeText}>{child.props.children}</CodeBlock>;
  },
  code({ className, children, ...props }) {
    return <code className={className ? `transcript-inline-code ${className}` : 'transcript-inline-code'} {...props}>{children}</code>;
  },
  input({ checked, type, ...props }) {
    return <input type={type} checked={checked} readOnly aria-label={checked ? '已完成' : '未完成'} {...props} />;
  }
  };
}

function safeMarkdownUrl(value: string): string {
  if (value.startsWith('#')) return value;
  if (safeHttpUrl(value) || /^file:/iu.test(value) || !/^[a-z][a-z\d+.-]*:/iu.test(value)) return value;
  return '';
}

function MarkdownLink({ messageId, href, title, children, ...props }: {
  messageId: string; href?: string; title?: string; children: ReactNode;
}) {
  if (!href) return <>{children}</>;
  if (href.startsWith('#')) return <a href={href}>{children}</a>;
  const type = linkedMediaType(href);
  if (type === 'image') return <ResolvedLinkedImage messageId={messageId} source={href} alt={plainText(children)} title={title} />;
  if (type === 'audio' || type === 'video') return <ResolvedLinkedMedia messageId={messageId} source={href} type={type} title={title || (type === 'audio' ? '音频' : '视频')} />;
  if (type === 'file' || !safeHttpUrl(href)) return <FilePreview messageId={messageId} url={href} title={title || '附件'} />;
  return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
}

type ResolvedAsset = { url: string | null; pending: boolean };

const resolvedAssetCache = new Map<string, string>();
const resolvedAssetRequests = new Map<string, Promise<string | null>>();
const RESOLVED_ASSET_CACHE_ENTRIES = 24;
const RESOLVED_ASSET_CACHE_CHARS = 32 * 1024 * 1024;

function resolvedAssetKey(messageId: string, source: string): string {
  return `${messageId}\0${source}`;
}

function cachedResolvedAsset(messageId: string, source: string): string | undefined {
  const key = resolvedAssetKey(messageId, source);
  const cached = resolvedAssetCache.get(key);
  if (!cached) return undefined;
  resolvedAssetCache.delete(key);
  resolvedAssetCache.set(key, cached);
  return cached;
}

function cacheResolvedAsset(messageId: string, source: string, url: string | null): void {
  if (!url) return;
  const key = resolvedAssetKey(messageId, source);
  resolvedAssetCache.delete(key);
  resolvedAssetCache.set(key, url);
  let totalChars = [...resolvedAssetCache.values()].reduce((total, value) => total + value.length, 0);
  while (resolvedAssetCache.size > RESOLVED_ASSET_CACHE_ENTRIES || totalChars > RESOLVED_ASSET_CACHE_CHARS) {
    const oldest = resolvedAssetCache.keys().next().value;
    if (!oldest) break;
    totalChars -= resolvedAssetCache.get(oldest)?.length ?? 0;
    resolvedAssetCache.delete(oldest);
  }
}

function resolveMessageAssetOnce(messageId: string, source: string): Promise<string | null> {
  const key = resolvedAssetKey(messageId, source);
  const cached = cachedResolvedAsset(messageId, source);
  if (cached) return Promise.resolve(cached);
  const existing = resolvedAssetRequests.get(key);
  if (existing) return existing;
  const request = window.rambo.resolveMessageAsset(messageId, source).then(url => {
    cacheResolvedAsset(messageId, source, url);
    return url;
  }).finally(() => {
    if (resolvedAssetRequests.get(key) === request) resolvedAssetRequests.delete(key);
  });
  resolvedAssetRequests.set(key, request);
  return request;
}

function useResolvedAsset(messageId: string, source: string): ResolvedAsset {
  const remote = safeHttpUrl(source);
  const [resolved, setResolved] = useState<{ source: string; url: string | null; pending: boolean }>(() => {
    const cached = cachedResolvedAsset(messageId, source);
    return { source, url: cached ?? null, pending: !cached && Boolean(source) && isLocalAssetReference(source) };
  });
  useEffect(() => {
    let active = true;
    if (!source || remote || source.startsWith('#') || !isLocalAssetReference(source)) {
      setResolved({ source, url: remote, pending: false });
      return () => { active = false; };
    }
    const cached = cachedResolvedAsset(messageId, source);
    if (cached) {
      setResolved({ source, url: cached, pending: false });
      return () => { active = false; };
    }
    setResolved({ source, url: null, pending: true });
    void resolveMessageAssetOnce(messageId, source).then(url => {
      if (active) setResolved({ source, url, pending: false });
    }).catch(() => { if (active) setResolved({ source, url: null, pending: false }); });
    return () => { active = false; };
  }, [messageId, remote, source]);
  if (remote) return { url: remote, pending: false };
  if (resolved.source === source) return { url: resolved.url, pending: resolved.pending };
  return { url: null, pending: Boolean(source) && isLocalAssetReference(source) };
}

function isLocalAssetReference(value: string): boolean {
  return /^file:/iu.test(value) || !/^[a-z][a-z\d+.-]*:/iu.test(value);
}

function ResolvedImage({ messageId, source, alt, title }: { messageId: string; source: string; alt: string; title?: string }) {
  const { url: resolved, pending } = useResolvedAsset(messageId, source);
  if (pending) return <span className="transcript-media-loading" role="status">正在读取图片…</span>;
  if (!resolved) return <span className="transcript-media-error">图片无法预览</span>;
  return <ImagePreview src={resolved} alt={alt} title={title} />;
}

function ResolvedLinkedMedia({ messageId, source, type, title }: { messageId: string; source: string; type: 'audio' | 'video'; title: string }) {
  const { url: resolved, pending } = useResolvedAsset(messageId, source);
  if (pending) return <span className="transcript-media-loading" role="status">正在读取{type === 'audio' ? '音频' : '视频'}…</span>;
  if (!resolved) return <span className="transcript-media-error">{title}无法预览</span>;
  return <AttachmentCard
    icon={type === 'audio' ? 'AUDIO' : 'VIDEO'}
    title={fileName(source, title)}
    detail={detailIfDistinct(type === 'audio' ? '音频' : '视频', title)}
    className="transcript-media-card"
    asset={{ messageId, source, resolved, fileName: fileName(source, title), local: isLocalAssetReference(source) }}
  >
    <MediaPlayer resolved={resolved} type={type} title={title} />
  </AttachmentCard>;
}

function ResolvedLinkedImage({ messageId, source, alt, title }: { messageId: string; source: string; alt: string; title?: string }) {
  const { url: resolved, pending } = useResolvedAsset(messageId, source);
  const asset = resolved ? {
    messageId,
    source,
    resolved,
    fileName: fileName(source, title),
    local: isLocalAssetReference(source)
  } : undefined;
  const actions = useAttachmentContextMenu(asset);
  if (pending) return <span className="transcript-media-loading" role="status">正在读取图片…</span>;
  if (!resolved) return <span className="transcript-media-error">图片无法预览</span>;
  return <figure className="transcript-linked-image" onContextMenu={actions.onContextMenu}>
    <ImagePreview src={resolved} alt={alt} title={title} />
    {actions.menu}
    {actions.notice}
  </figure>;
}

function plainText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return Children.toArray(value).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (isValidElement(child)) return plainText((child.props as { children?: ReactNode }).children);
    return '';
  }).join('');
}

function CodeBlock({ language, source, children }: { language: string; source: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lines = source.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { setCopied(false); }
  };
  return (
    <section className="transcript-code-block" aria-label={language ? `${language} 代码块` : '代码块'}>
      <header className="transcript-code-header">
        <span>{language || '代码'}</span>
        <button type="button" onClick={() => void copy()} aria-label="复制代码">{copied ? '已复制' : '复制'}</button>
      </header>
      <pre className="transcript-code-pre">
        <span className="transcript-code-gutter" aria-hidden="true">{lines.map((_, index) => index + 1).join('\n')}</span>
        <code className={language ? `language-${language} hljs` : 'hljs'}>{children}</code>
      </pre>
    </section>
  );
}

function MermaidDiagram({ source }: { source: string }) {
  const rawId = useId();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const id = `rambo-diagram-${rawId.replace(/[^a-zA-Z0-9_-]/gu, '')}`;
    void import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base' });
      return mermaid.render(id, source);
    }).then(result => {
      if (!active) return;
      setSvg(result.svg);
      setError(false);
    }).catch(() => {
      if (active) { setSvg(''); setError(true); }
    });
    return () => { active = false; };
  }, [rawId, source]);
  if (error) return <pre className="transcript-diagram-error"><code>{source}</code><span>图表暂时无法绘制</span></pre>;
  if (!svg) return <div className="transcript-diagram-loading" role="status">正在绘制图表…</div>;
  return <div className="transcript-mermaid" role="img" aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function ImagePreview({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!open) setZoom(1);
  }, [open]);
  const changeZoom = (value: number) => {
    const next = Math.max(0.25, Math.min(4, value));
    setZoom(Math.round(next * 100) / 100);
  };
  useEffect(() => {
    if (!open) {
      setNaturalSize(null);
      return;
    }
    const image = new Image();
    image.onload = () => setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => setNaturalSize(null);
    image.src = src;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [open, src]);
  return (
    <>
      <figure className="transcript-image-figure">
        <button type="button" className="transcript-image-button" onClick={() => setOpen(true)} aria-label={alt ? `预览图片：${alt}` : '预览图片'}>
          <img src={src} alt={alt} title={title} loading="lazy" />
        </button>
      </figure>
      {open && <FileViewer
        title={title || alt || '图片'}
        subtitle="图片"
        onClose={() => setOpen(false)}
        actions={<ImageZoomActions zoom={zoom} onChange={changeZoom} />}
      >
        <div
          className="transcript-file-viewer-image-stage"
          onDoubleClick={() => changeZoom(zoom === 1 ? 2 : 1)}
        >
          <img
            src={src}
            alt={alt}
            style={naturalSize ? { width: naturalSize.width * zoom, height: naturalSize.height * zoom } : undefined}
          />
        </div>
      </FileViewer>}
    </>
  );
}

function ImageZoomActions({ zoom, onChange }: { zoom: number; onChange: (value: number) => void }) {
  return <>
    <button type="button" onClick={() => onChange(zoom - 0.25)} disabled={zoom <= 0.25} aria-label="缩小图片" title="缩小">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10h9" /></svg>
    </button>
    <button type="button" className="transcript-file-viewer-zoom-value" onClick={() => onChange(1)} aria-label={`当前缩放 ${Math.round(zoom * 100)}%，重置`} title="恢复为 100%">
      {Math.round(zoom * 100)}%
    </button>
    <button type="button" onClick={() => onChange(zoom + 0.25)} disabled={zoom >= 4} aria-label="放大图片" title="放大">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10h9M10 5.5v9" /></svg>
    </button>
  </>;
}

function QuestionCard({ messageId, content }: { messageId: string; content: QuestionMessageContent }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = content.state === 'pending';
  const submit = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true); setError('');
    try { await window.rambo.answerCard(messageId, answer); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '答案发送失败'); }
    finally { setBusy(false); }
  };
  const toggle = (option: MessageOption) => {
    const value = option.value ?? option.label;
    if (!content.allowMultiple) { void submit(value); return; }
    setSelected(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value]);
  };
  return (
    <section className={`transcript-question-card${pending ? '' : ' is-answered'}`} aria-label="交互问题">
      <h3>{content.prompt}</h3>
      {pending ? (
        <div className="transcript-question-options">
          {content.options.map((option, index) => {
            const value = option.value ?? option.label;
            const active = selected.includes(value);
            return (
              <button key={`${value}-${index}`} type="button" disabled={busy}
                aria-pressed={content.allowMultiple ? active : undefined}
                className={`transcript-question-option${active ? ' is-selected' : ''}`}
                onClick={() => toggle(option)}>
                <span className="transcript-question-key" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
                <span className="transcript-question-option-copy">
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </span>
              </button>
            );
          })}
          {content.allowMultiple && (
            <button type="button" className="transcript-card-submit" disabled={busy || selected.length === 0}
              onClick={() => void submit(JSON.stringify(selected))}>提交选择</button>
          )}
          <p className="transcript-question-hint">也可以直接在聊天输入框中回答。</p>
          {error && <p className="transcript-card-error" role="alert">{error}</p>}
        </div>
      ) : (
        <div className="transcript-question-resolved"><span>已回答</span><p>{content.answer}</p></div>
      )}
    </section>
  );
}

function ResultCard({ messageId, content }: { messageId: string; content: ResultCardMessageContent }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = content.state === 'pending';
  const submit = async (answer: string) => {
    if (!pending || busy) return;
    setBusy(true); setError('');
    try { await window.rambo.answerCard(messageId, answer); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '提交失败'); }
    finally { setBusy(false); }
  };
  const handleAction = (action: MessageOption) => void submit(action.value ?? action.label);
  const handleForm = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload: Record<string, string | boolean> = {};
    for (const field of content.formFields ?? []) {
      const value = data.get(field.name);
      payload[field.name] = field.type === 'checkbox' ? value === 'on' : String(value ?? '');
    }
    void submit(JSON.stringify(payload));
  };
  return (
    <section className={`transcript-result-card template-${content.template}${pending ? '' : content.state === 'answered' ? ' is-answered' : ''}`}>
      <header className="transcript-result-header">
        <div><h3>{content.title}</h3>{content.subtitle && <p>{content.subtitle}</p>}</div>
        <span className="transcript-result-template">{templateLabel(content.template)}</span>
      </header>
      {content.summary && <p className="transcript-result-summary">{content.summary}</p>}
      {content.fields?.length ? <dl className="transcript-result-fields">{content.fields.map((field, index) => <div key={`${field.label}-${index}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl> : null}
      {content.sections?.map((section, index) => <section className="transcript-result-section" key={`${section.title ?? 'section'}-${index}`}>
        {section.title && <h4>{section.title}</h4>}<p>{section.body}</p>
      </section>)}
      {content.items?.length ? <ul className="transcript-result-items">{content.items.map((item, index) => <li key={`${item.title}-${index}`}>
        {item.imageUrl && <ResolvedInlineImage messageId={messageId} source={item.imageUrl} />}
        <div><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}{item.metadata && <small>{item.metadata}</small>}</div>
      </li>)}</ul> : null}
      {pending && content.formFields?.length ? <form className="transcript-card-form" onSubmit={handleForm}>
        {content.formFields.map(field => <FormField key={field.name} field={field} value={values[field.name]}
          onChange={value => setValues(current => ({ ...current, [field.name]: value }))} />)}
        <button className="transcript-card-submit" type="submit" disabled={busy}>提交</button>
      </form> : null}
      {pending && content.actions?.length ? <div className="transcript-card-actions">{content.actions.map((action, index) =>
        <button key={`${action.label}-${index}`} type="button" disabled={busy} onClick={() => handleAction(action)}>{action.label}</button>)}</div> : null}
      {content.state === 'answered' && <div className="transcript-question-resolved"><span>已完成</span><p>{content.answer}</p></div>}
      {error && <p className="transcript-card-error" role="alert">{error}</p>}
    </section>
  );
}

function FormField({ field, value, onChange }: {
  field: MessageFormField; value: string | boolean | undefined; onChange: (value: string | boolean) => void;
}) {
  if (field.type === 'checkbox') return <label className="transcript-card-field transcript-card-checkbox">
    <input type="checkbox" name={field.name} required={field.required} checked={value === true}
      onChange={event => onChange(event.currentTarget.checked)} />{field.label}
  </label>;
  if (field.type === 'select') return <label className="transcript-card-field"><span>{field.label}</span>
    <select name={field.name} required={field.required} value={String(value ?? '')} onChange={event => onChange(event.currentTarget.value)}>
      <option value="">请选择</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}
    </select></label>;
  if (field.type === 'textarea') return <label className="transcript-card-field"><span>{field.label}</span>
    <textarea name={field.name} required={field.required} placeholder={field.placeholder} value={String(value ?? '')}
      onChange={event => onChange(event.currentTarget.value)} /></label>;
  return <label className="transcript-card-field"><span>{field.label}</span>
    <input name={field.name} type={field.type} required={field.required} placeholder={field.placeholder} value={String(value ?? '')}
      onChange={event => onChange(event.currentTarget.value)} /></label>;
}

function MediaContent({ messageId, content }: { messageId: string; content: Extract<MessageContent, { kind: 'media' }> }) {
  const { url, pending } = useResolvedAsset(messageId, content.url);
  if (pending) return <p className="transcript-media-loading" role="status">正在读取文件…</p>;
  if (!url) return <p className="transcript-media-error">媒体地址无效</p>;
  if (content.mediaType === 'video' || content.mediaType === 'audio') {
    return <AttachmentCard
      icon={content.mediaType === 'audio' ? 'AUDIO' : 'VIDEO'}
      title={fileName(content.url, content.title ?? (content.mediaType === 'audio' ? '音频' : '视频'))}
      detail={detailIfDistinct(content.mediaType === 'audio' ? '音频' : '视频', content.title)}
      className="transcript-media-card"
      asset={{
        messageId,
        source: content.url,
        resolved: url,
        fileName: fileName(content.url, content.title),
        local: isLocalAssetReference(content.url)
      }}
    >
      <MediaPlayer resolved={url} type={content.mediaType} title={content.title ?? (content.mediaType === 'audio' ? '音频' : '视频')} />
      {content.caption && <p className="transcript-attachment-caption">{content.caption}</p>}
    </AttachmentCard>;
  }
  if (content.mediaType === 'image') return <AttachmentCard
    icon="IMAGE"
    title={fileName(content.url, content.title ?? '图片')}
    className="transcript-media-card"
    asset={{
      messageId,
      source: content.url,
      resolved: url,
      fileName: fileName(content.url, content.title),
      local: isLocalAssetReference(content.url)
    }}
  >
    <ImagePreview src={url} alt={content.alt ?? content.title ?? ''} title={content.caption} />
    {content.caption && <p className="transcript-attachment-caption">{content.caption}</p>}
  </AttachmentCard>;
  return <FilePreview messageId={messageId} url={content.url} title={content.title ?? content.mimeType ?? '附件'} />;
}

function AttachmentCard({ icon, title, detail, className = '', asset, children }: {
  icon: string; title: string; detail?: string; className?: string; asset?: AttachmentAsset; children: ReactNode;
}) {
  const actions = useAttachmentContextMenu(asset);
  return <section
    className={`transcript-attachment-card ${className}`.trim()}
    data-attachment-card
    onContextMenu={actions.onContextMenu}
  >
    <header className="transcript-attachment-card-header">
      <span className="transcript-file-icon" aria-hidden="true">{icon}</span>
      <span className="transcript-attachment-card-copy">
        <strong title={title}>{title}</strong>
        {detail && <small title={detail}>{detail}</small>}
      </span>
    </header>
    {children}
    {actions.menu}
    {actions.notice}
  </section>;
}

function MediaPlayer({ resolved, type, title }: { resolved: string; type: 'audio' | 'video'; title: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="transcript-media-player">
    {type === 'audio'
      ? <audio className="transcript-audio" controls preload="metadata" src={resolved} aria-label={title} onError={() => setFailed(true)} />
      : <video className="transcript-video" controls preload="metadata" src={resolved} aria-label={title} onError={() => setFailed(true)} />}
    {failed && <span className="transcript-media-error" role="status">此音视频编码无法在应用内播放，可用本机应用打开文件。</span>}
  </div>;
}

function VoiceContent({ messageId, content }: { messageId: string; content: Extract<MessageContent, { kind: 'voice' }> }) {
  const { url } = useResolvedAsset(messageId, content.audioUrl ?? '');
  return <section className="transcript-voice-row" aria-label="语音消息">
    <span className="transcript-voice-icon" aria-hidden="true">◖</span>
    <div className="transcript-voice-body">
      <div className="transcript-voice-meta">{content.speaker ?? '语音消息'}{content.durationSeconds ? ` · ${formatDuration(content.durationSeconds)}` : ''}</div>
      {content.transcript && <p>{content.transcript}</p>}
      {url && <audio controls preload="metadata" src={url} aria-label="播放语音" />}
    </div>
  </section>;
}

function McpEmbed({ content }: { content: Extract<MessageContent, { kind: 'mcp_embed' }> }) {
  const [failed, setFailed] = useState(false);
  const url = safeHttpUrl(content.url);
  return <section className="transcript-mcp-card">
    <header><span className="transcript-mcp-mark" aria-hidden="true">MCP</span><div><strong>{content.title ?? content.appName}</strong><small>{content.appName}</small></div></header>
    {content.description && <p>{content.description}</p>}
    {url && !failed ? <iframe title={content.title ?? content.appName} src={url} loading="lazy" sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <a href={content.url} target="_blank" rel="noreferrer">打开嵌入应用</a>}
  </section>;
}

function FilePreview({ messageId, url, title }: { messageId: string; url: string; title: string }) {
  const { url: resolved, pending } = useResolvedAsset(messageId, url);
  const preview = filePreviewKind(url);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [textState, setTextState] = useState<{ source: string; text?: string; error?: string }>({ source: '' });
  const textPreview = preview === 'text' || preview === 'markdown' || preview === 'csv';
  useEffect(() => {
    let active = true;
    if (!resolved || !textPreview) return () => { active = false; };
    setTextState({ source: url });
    const load = async () => {
      try {
        const response = await fetch(resolved);
        if (!response.ok) throw new Error('读取失败');
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > 2 * 1024 * 1024) throw new Error('文件超过 2 MiB，无法在聊天内预览');
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error('文件超过 2 MiB，无法在聊天内预览');
        if (active) setTextState({ source: url, text });
      } catch (error) {
        if (active) setTextState({ source: url, error: error instanceof Error ? error.message : '读取失败' });
      }
    };
    void load();
    return () => { active = false; };
  }, [resolved, textPreview, url]);

  if (pending) return <span className="transcript-media-loading" role="status">正在读取文件…</span>;
  if (!resolved) return <span className="transcript-media-error">文件地址无效或文件不可用</span>;
  const local = isLocalAssetReference(url);
  const displayName = fileName(url, title);
  const typeLabel = previewLabel(preview, url);
  const detail = displayName === title ? typeLabel : detailIfDistinct(typeLabel, title);
  const currentText = textState.source === url ? textState.text : undefined;
  return <AttachmentCard
    icon={fileIcon(preview, url)}
    title={displayName}
    detail={detail}
    className="transcript-file-card"
    asset={{ messageId, source: url, resolved, fileName: displayName, local }}
  >
    {preview === 'image' && <ImagePreview src={resolved} alt={title} title={title} />}
    {preview && preview !== 'image' && <button type="button" className="transcript-file-preview-trigger" onClick={() => setViewerOpen(true)}>预览</button>}
    {textPreview && textState.source === url && textState.error && <span className="transcript-file-preview-error" role="status">{textState.error}</span>}
    {viewerOpen && preview && preview !== 'image' && <FileViewer title={displayName} subtitle={previewLabel(preview, url)} onClose={() => setViewerOpen(false)}>
      {preview === 'pdf'
        ? <iframe className="transcript-file-viewer-pdf" title={`${displayName} PDF 预览`} src={resolved} loading="lazy" sandbox="allow-scripts" referrerPolicy="no-referrer" />
        : textState.source !== url
          ? <div className="transcript-file-viewer-state" role="status">正在加载预览…</div>
          : textState.error
            ? <div className="transcript-file-viewer-state" role="status">{textState.error}</div>
            : preview === 'markdown'
              ? <div className="transcript-file-viewer-text"><MarkdownBody messageId={messageId} text={currentText ?? ''} /></div>
              : preview === 'csv'
                ? <div className="transcript-file-viewer-table"><CsvPreview text={currentText ?? ''} /></div>
                : <pre className="transcript-file-viewer-text transcript-plain-text">{currentText ?? ''}</pre>}
    </FileViewer>}
  </AttachmentCard>;
}

function FileViewer({ title, subtitle, onClose, actions, children }: {
  title: string; subtitle: string; onClose: () => void; actions?: ReactNode; children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overflow = bodyOverflow;
    };
  }, [onClose]);
  return createPortal(<div className="transcript-file-viewer-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="transcript-file-viewer" role="dialog" aria-modal="true" aria-label={`${title}预览`}>
      <header className="transcript-file-viewer__stage-chrome">
        <div className="transcript-file-viewer-heading"><strong title={title}>{title}</strong><small>{subtitle}</small></div>
        <div className="transcript-file-viewer-toolbar">
          {actions}
          <button type="button" onClick={onClose} aria-label="关闭文件预览" title="关闭">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
        </div>
      </header>
      <div className="transcript-file-viewer-body">{children}</div>
    </section>
  </div>, document.body);
}

function previewLabel(preview: ReturnType<typeof filePreviewKind>, source: string): string {
  if (preview === 'image') return '图片';
  if (preview === 'pdf') return 'PDF';
  if (preview === 'text') return '纯文本';
  if (preview === 'markdown') return 'Markdown';
  if (preview === 'csv') return 'CSV 表格';
  return fileExtension(source).toLocaleUpperCase() || '文件';
}

function CsvPreview({ text }: { text: string }) {
  const parsed = parseCsv(text);
  if (!parsed.rows.length) return <div className="transcript-file-viewer-state">CSV 文件没有可显示的内容。</div>;
  return <div className="transcript-csv-scroll" role="region" aria-label="CSV 表格预览" tabIndex={0}>
    <table><thead><tr>{parsed.rows[0].map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>
      <tbody>{parsed.rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>
        {parsed.rows[0].map((_, colIndex) => <td key={colIndex}>{row[colIndex] ?? ''}</td>)}
      </tr>)}</tbody>
    </table>
    {parsed.truncated && <p className="transcript-csv-truncated">仅显示前 2,000 行。</p>}
  </div>;
}

function parseCsv(text: string): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some(value => value.length) || rows.length) rows.push(row);
      row = [];
      if (rows.length >= 2_001) { truncated = index < text.length - 1; break; }
    } else cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some(value => value.length) || rows.length) rows.push(row);
  }
  const columns = Math.min(80, ...rows.map(value => value.length));
  const normalized = rows.slice(0, 2_001).map(value => value.slice(0, columns));
  return { rows: normalized, truncated: truncated || rows.length > 2_001 };
}

type AttachmentAsset = {
  messageId: string;
  source: string;
  resolved: string;
  fileName: string;
  local: boolean;
};

function useAttachmentContextMenu(asset: AttachmentAsset | null | undefined) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const menuId = useId();

  useEffect(() => {
    if (!position) return;
    const menu = document.getElementById(menuId);
    menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[role="menu"]')) return;
      setPosition(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPosition(null);
    };
    const closeOnViewportChange = () => setPosition(null);
    const closeOnBlur = () => setPosition(null);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('blur', closeOnBlur);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('blur', closeOnBlur);
    };
  }, [menuId, position]);

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!asset) return;
    event.preventDefault();
    const menuWidth = 210;
    const menuHeight = asset.local ? 128 : 38;
    const anchor = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || anchor.left + 16;
    const y = event.clientY || anchor.top + 16;
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))
    });
    setError('');
  };

  const save = async () => {
    if (!asset) return;
    setPosition(null);
    try {
      const destination = await window.rambo.saveMessageAsset(asset.messageId, asset.source, asset.fileName);
      setSaved(Boolean(destination));
      setActionMessage(destination ? `已保存到 ${asset.fileName}` : '');
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法保存文件'); }
  };
  const open = async () => {
    if (!asset) return;
    setPosition(null);
    try { await window.rambo.openMessageAsset(asset.messageId, asset.source); setError(''); setActionMessage('已交给本机应用打开'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法打开文件'); }
  };
  const reveal = async () => {
    if (!asset) return;
    setPosition(null);
    try { await window.rambo.revealMessageAsset(asset.messageId, asset.source); setError(''); setActionMessage('已在 Finder 中显示'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法在 Finder 中定位文件'); }
  };

  const menu = position && asset
    ? createPortal(<div
        id={menuId}
        className="transcript-file-menu"
        role="menu"
        aria-label={`${asset.fileName} 文件操作`}
        style={{ left: position.x, top: position.y }}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
          const current = items.indexOf(document.activeElement as HTMLElement);
          const offset = event.key === 'ArrowDown' ? 1 : -1;
          items[(current + offset + items.length) % items.length]?.focus();
        }}
      >
        {asset.local ? <>
          <button type="button" role="menuitem" onClick={() => void save()}>
            <FileActionIcon kind={saved ? 'check' : 'save'} /><span>{saved ? '已保存' : '保存'}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void open()}>
            <FileActionIcon kind="open" /><span>用本机应用打开</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void reveal()}>
            <FileActionIcon kind="folder" /><span>在 Finder 中显示</span>
          </button>
        </> : <a role="menuitem" href={asset.resolved} target="_blank" rel="noreferrer">
          <FileActionIcon kind="open" /><span>打开</span>
        </a>}
      </div>, document.body)
    : null;
  const notice = (error || actionMessage)
    ? <span className={`transcript-file-action-status${error ? ' is-error' : ''}`} role="status" aria-live="polite">{error || actionMessage}</span>
    : null;
  return { onContextMenu, menu, notice };
}

function FileActionIcon({ kind }: { kind: 'save' | 'check' | 'open' | 'folder' }) {
  if (kind === 'folder') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.75 5.5h5.1l1.7 1.7h7.7v8.05H2.75z" /><path d="M2.75 7.2V4.75h5.1l1.7 1.7" /></svg>;
  if (kind === 'open') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.5 3.25h5.25V8.5" /><path d="m16.5 3.5-7 7" /><path d="M15.5 10.5v5.75H4.25V5.5H10" /></svg>;
  if (kind === 'check') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10.25 3.75 3.5L16 5.75" /></svg>;
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.25v9.5m0 0 3.5-3.5M10 12.75l-3.5-3.5" /><path d="M4.25 13.5v3.25h11.5V13.5" /></svg>;
}

function filePreviewKind(source: string): 'image' | 'pdf' | 'text' | 'markdown' | 'csv' | null {
  const extension = fileExtension(source);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'txt') return 'text';
  if (['md', 'markdown'].includes(extension)) return 'markdown';
  if (extension === 'csv') return 'csv';
  return null;
}

function fileExtension(source: string): string {
  const path = displayPath(source).split(/[\\/]/u).pop() ?? '';
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1).toLocaleLowerCase();
}

function fileName(source: string, fallback = '附件'): string {
  const path = displayPath(source).split(/[\\/]/u).pop();
  if (!path) return fallback;
  try { return decodeURIComponent(path); }
  catch { return path; }
}

function displayPath(source: string): string {
  const path = source.split(/[?#]/u)[0];
  if (!isLocalAssetReference(source)) return path;
  return path.replace(/:(\d+)(?::\d+)?$/u, '');
}

function detailIfDistinct(type: string, detail?: string): string | undefined {
  if (!detail) return undefined;
  const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  return normalize(detail) === normalize(type) ? undefined : detail;
}

function fileIcon(preview: ReturnType<typeof filePreviewKind>, source: string): string {
  if (preview === 'image') return 'IMAGE';
  if (preview === 'pdf') return 'PDF';
  if (preview === 'csv') return 'CSV';
  if (preview === 'markdown') return 'MD';
  if (preview === 'text') return 'TXT';
  return fileExtension(source).toLocaleUpperCase().slice(0, 5) || 'FILE';
}

function ResolvedInlineImage({ messageId, source }: { messageId: string; source: string }) {
  const { url: resolved, pending } = useResolvedAsset(messageId, source);
  if (pending) return <span className="transcript-media-loading" role="status">正在读取图片…</span>;
  return resolved ? <img src={resolved} alt="" loading="lazy" /> : <span className="transcript-media-error">图片不可用</span>;
}

function Visualization({ content }: { content: VisualizationMessageContent }) {
  return <section className="transcript-visualization">
    {content.title && <h3>{content.title}</h3>}
    {content.chartType === 'table' ? <ChartDataTable content={content} /> : <ChartSvg content={content} />}
    {content.chartType !== 'table' && <ChartDataTable content={content} />}
  </section>;
}

function ChartSvg({ content }: { content: VisualizationMessageContent }) {
  const width = Math.max(480, 76 * content.labels.length + 96);
  const height = 230;
  const left = 44, right = width - 16, top = 18, bottom = 188;
  const values = content.series.flatMap(series => series.values);
  const maxValue = Math.max(1, ...values);
  const minValue = Math.min(0, ...values);
  const range = Math.max(1, maxValue - minValue);
  const colors = ['#11a995', '#5b82e8', '#f28c45', '#8b66ce', '#3b9fc0', '#d96f91'];
  const colorsFor = (index: number) => colors[index % colors.length];
  const points = (seriesIndex: number, seriesValues: number[]) => seriesValues.map((value, index) => ({
    x: left + (content.labels.length <= 1 ? (right - left) / 2 : index * (right - left) / (content.labels.length - 1)),
    y: top + (maxValue - value) * (bottom - top) / range,
    value,
    index
  }));
  return <div className="transcript-chart-scroll" role="region" aria-label="可横向滚动的图表" tabIndex={0}>
    <svg className="transcript-chart-svg" role="img" aria-label={content.title ?? '数据图表'} viewBox={`0 0 ${width} ${height}`}>
      {content.chartType !== 'pie' && <>
        <line x1={left} y1={top} x2={left} y2={bottom} />
        <line x1={left} y1={bottom} x2={right} y2={bottom} />
      </>}
      {content.chartType === 'bar' && content.labels.map((label, index) => {
        const groupWidth = (right - left) / content.labels.length;
        const barWidth = Math.max(6, Math.min(34, groupWidth / (content.series.length + 1)));
        return <g key={`${label}-${index}`}>
          {content.series.map((series, seriesIndex) => {
            const value = series.values[index] ?? 0;
            const y = top + (maxValue - value) * (bottom - top) / range;
            const zero = top + (maxValue - 0) * (bottom - top) / range;
            const x = left + groupWidth * index + groupWidth / 2 + (seriesIndex - (content.series.length - 1) / 2) * (barWidth + 3) - barWidth / 2;
            return <rect key={series.name} x={x} y={Math.min(y, zero)} width={barWidth} height={Math.max(1, Math.abs(zero - y))} rx="3" fill={colorsFor(seriesIndex)} />;
          })}
          <text x={left + groupWidth * index + groupWidth / 2} y={bottom + 20} textAnchor="middle">{shorten(label)}</text>
        </g>;
      })}
      {content.chartType === 'line' && content.series.map((series, seriesIndex) => {
        const coordinates = points(seriesIndex, series.values);
        return <g key={series.name}>
          <polyline fill="none" stroke={colorsFor(seriesIndex)} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"
            points={coordinates.map(point => `${point.x},${point.y}`).join(' ')} />
          {coordinates.map(point => <circle key={point.index} cx={point.x} cy={point.y} r="4" fill={colorsFor(seriesIndex)} />)}
        </g>;
      })}
      {content.chartType === 'line' && content.labels.map((label, index) => <text key={`${label}-${index}`}
        x={points(0, content.series[0]?.values ?? [])[index]?.x ?? left} y={bottom + 20} textAnchor="middle">{shorten(label)}</text>)}
      {content.chartType === 'pie' && <PieChart content={content} colors={colors} />}
      {content.series.map((series, index) => <g key={series.name} transform={`translate(${left + index * 150},${height - 9})`}>
        <circle cx="0" cy="0" r="4" fill={colorsFor(index)} /><text x="9" y="4">{shorten(series.name, 18)}</text>
      </g>)}
      {content.unit && <text x="4" y="15">{content.unit}</text>}
    </svg>
  </div>;
}

function PieChart({ content, colors }: { content: VisualizationMessageContent; colors: string[] }) {
  const values = content.series[0]?.values ?? [];
  const positive = values.map(value => Math.max(0, value));
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  const cx = 235, cy = 104, radius = 78;
  let angle = -Math.PI / 2;
  return <g>{positive.map((value, index) => {
    if (!value) return null;
    const next = angle + value / total * Math.PI * 2;
    const x1 = cx + radius * Math.cos(angle), y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(next), y2 = cy + radius * Math.sin(next);
    const large = next - angle > Math.PI ? 1 : 0;
    const path = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`;
    angle = next;
    return <path key={`${content.labels[index]}-${index}`} d={path} fill={colors[index % colors.length]} />;
  })}</g>;
}

function ChartDataTable({ content }: { content: VisualizationMessageContent }) {
  return <div className="transcript-table-scroll"><table className="transcript-chart-table">
    <thead><tr><th scope="col">项目</th>{content.series.map(series => <th scope="col" key={series.name}>{series.name}</th>)}</tr></thead>
    <tbody>{content.labels.map((label, row) => <tr key={`${label}-${row}`}>
      <th scope="row">{label}</th>{content.series.map(series => <td key={series.name}>{formatNumber(series.values[row], content.unit)}</td>)}
    </tr>)}</tbody>
  </table></div>;
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

function linkedMediaType(href?: string): 'image' | 'audio' | 'video' | 'file' | null {
  if (!href) return null;
  const path = href.split(/[?#]/u)[0].toLocaleLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif)$/u.test(path)) return 'image';
  if (/\.(mp3|m4a|wav|ogg|aac|flac|opus)$/u.test(path)) return 'audio';
  if (/\.(mp4|webm|mov|m4v|ogv)$/u.test(path)) return 'video';
  if (/\.(pdf|docx?|xlsx?|pptx?|zip|csv|json|txt|md|markdown)$/u.test(path)) return 'file';
  return null;
}

function templateLabel(template: ResultCardMessageContent['template']): string {
  const labels: Record<ResultCardMessageContent['template'], string> = {
    generic: '结果', weather: '天气', shopping: '购物', form: '表单', approval: '审批',
    connector: '连接器', email: '邮件', calendar: '日历'
  };
  return labels[template];
}

function shorten(value: string, max = 12): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatNumber(value: number | undefined, unit?: string): string {
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value ?? 0)}${unit ? ` ${unit}` : ''}`;
}

function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
