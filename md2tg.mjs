// Markdown (as Claude writes it) -> Telegram HTML (parse_mode "HTML").
// Supported: ```code blocks```, `inline code`, **bold**, __bold__, ~~strike~~, [text](url), # headings -> bold,
// "- " / "* " list markers -> "•". Everything else is escaped and sent as-is. Tables are not supported by
// Telegram and stay as plain text. Single *italic* / _italic_ are deliberately NOT converted: they collide
// with snake_case names, multiplication and paths.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  const parts = s.split(/(`[^`\n]+`)/); // keep inline code untouched by the other rules
  return parts
    .map((p, i) => {
      if (i % 2) return `<code>${esc(p.slice(1, -1))}</code>`;
      let t = esc(p);
      t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${url.replace(/"/g, "&quot;")}">${txt}</a>`);
      t = t.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, "<b>$1</b>").replace(/__(?=\S)([^_\n]+?)__/g, "<b>$1</b>");
      t = t.replace(/~~(?=\S)([^~\n]+?)~~/g, "<s>$1</s>");
      return t;
    })
    .join("");
}

export function mdToTgHtml(md) {
  const out = [];
  const lines = String(md).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      const lang = fence[1] ? ` class="language-${fence[1]}"` : "";
      out.push(`<pre><code${lang}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = lines[i].match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) {
      out.push(`<b>${inline(h[1])}</b>`);
      continue;
    }
    out.push(inline(lines[i].replace(/^(\s*)[-*]\s+/, "$1• ")));
  }
  return out.join("\n");
}

// Split markdown into chunks of at most `max` characters on line boundaries, never inside a code fence
// (a fence that has to be split is closed and reopened), so each chunk converts to valid HTML on its own.
export function splitMarkdown(md, max = 3500) {
  const chunks = [];
  let cur = [], len = 0, fence = null;
  const flush = () => {
    if (!cur.length) return;
    if (fence !== null) cur.push("```");
    chunks.push(cur.join("\n"));
    cur = fence !== null ? ["```" + fence] : [];
    len = cur.reduce((a, l) => a + l.length + 1, 0);
  };
  for (const raw of String(md).split("\n")) {
    for (let line = raw; ; ) {
      const piece = line.length > max ? line.slice(0, max) : line;
      if (len + piece.length + 1 > max) flush();
      cur.push(piece);
      len += piece.length + 1;
      const f = piece.match(/^\s*```\s*([\w+-]*)\s*$/);
      if (f) fence = fence === null ? f[1] : null;
      if (line.length <= max) break;
      line = line.slice(max);
    }
  }
  if (cur.length && !(cur.length === 1 && fence !== null && cur[0].startsWith("```"))) {
    fence = null;
    chunks.push(cur.join("\n"));
  }
  return chunks;
}
