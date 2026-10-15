// Lumo agent runner: an OpenAI-compatible chat-completions loop (lumo-tamer) with local tools.
// Lumo asks for a tool -> the bot runs it on this machine -> the result goes back to Lumo, until Lumo answers in text.
// Each topic keeps its own conversation in sessions/<id>.json, so sessions survive restarts.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";

const BASE_URL = (process.env.LUMO_BASE_URL || "http://tamer:3003/v1").replace(/\/+$/, "");
const API_KEY = process.env.LUMO_API_KEY;
export const MODELS = ["lumo", "lumo-lite", "lumo-max"];
export const DEFAULT_MODEL = MODELS.includes(process.env.LUMO_MODEL) ? process.env.LUMO_MODEL : "lumo";
const MAX_STEPS = Number(process.env.LUMO_MAX_STEPS) || 25; // tool rounds per message
const HISTORY_MAX = Number(process.env.LUMO_HISTORY_MAX) || 60; // messages sent to Lumo per request
const OUT_MAX = Number(process.env.LUMO_TOOL_OUTPUT_MAX) || 8000; // chars of tool output sent back
const CMD_TIMEOUT = Number(process.env.LUMO_CMD_TIMEOUT) || 120; // seconds
const REQ_TIMEOUT = Number(process.env.LUMO_REQUEST_TIMEOUT) || 300; // seconds per Lumo request

if (!API_KEY) throw new Error("LUMO_API_KEY обязателен (.env)");

// ---- sessions on disk ----
const SESSIONS = new URL("./sessions/", import.meta.url);
mkdirSync(SESSIONS, { recursive: true });
const sessionFile = (id) => new URL(`${id.replace(/[^\w-]/g, "")}.json`, SESSIONS);
export const loadHistory = (id) => (existsSync(sessionFile(id)) ? JSON.parse(readFileSync(sessionFile(id), "utf8")) : []);
const saveHistory = (id, h) => writeFileSync(sessionFile(id), JSON.stringify(h, null, 1));

// the window sent to Lumo: last HISTORY_MAX messages, starting at a user message (never at an orphan tool result)
function windowOf(history) {
  let h = history.slice(-HISTORY_MAX);
  const first = h.findIndex((m) => m.role === "user");
  return first > 0 ? h.slice(first) : h;
}

// after /stop the last assistant message may have tool calls without results: answer them, or the next request is invalid
function repair(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user") return;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const done = new Set(history.slice(i + 1).filter((x) => x.role === "tool").map((x) => x.tool_call_id));
    const missing = m.tool_calls.filter((c) => !done.has(c.id));
    history.push(...missing.map((c) => ({ role: "tool", tool_call_id: c.id, content: "Прервано пользователем." })));
    return;
  }
}

const clip = (s, max = OUT_MAX) => {
  s = String(s ?? "");
  return s.length > max ? s.slice(0, max / 2) + `\n…[обрезано ${s.length - max} символов]…\n` + s.slice(-max / 2) : s;
};

// ---- tools ----
const fn = (name, description, properties, required) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});
const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });

export const TOOLS = [
  fn("run_command", "Выполнить команду bash в рабочей папке. Возвращает код выхода и вывод (stdout+stderr).", {
    command: str("Команда bash"),
    timeout_sec: int(`Таймаут в секундах, по умолчанию ${CMD_TIMEOUT}`),
  }, ["command"]),
  fn("read_file", "Прочитать текстовый файл (можно диапазон строк). Строки пронумерованы.", {
    path: str("Путь к файлу"),
    start_line: int("Первая строка, с 1"),
    end_line: int("Последняя строка включительно"),
  }, ["path"]),
  fn("list_dir", "Показать содержимое папки.", { path: str("Путь к папке, по умолчанию рабочая папка") }, []),
  fn("write_file", "Создать или перезаписать файл целиком. Для файлов длиннее ~80 строк пиши первую часть здесь, остальное через append_file.", {
    path: str("Путь к файлу"),
    content: str("Содержимое"),
  }, ["path", "content"]),
  fn("append_file", "Дописать текст в конец файла (для записи больших файлов частями).", {
    path: str("Путь к файлу"),
    content: str("Текст для добавления"),
  }, ["path", "content"]),
  fn("edit_file", "Заменить в файле фрагмент old_string на new_string. old_string должен встречаться в файле ровно один раз.", {
    path: str("Путь к файлу"),
    old_string: str("Точный фрагмент, который нужно заменить"),
    new_string: str("Новый текст"),
  }, ["path", "old_string", "new_string"]),
];
export const SAFE_TOOLS = new Set(["read_file", "list_dir"]); // run without asking

const home = process.env.HOME || "/";
const pathIn = (cwd, p) => resolve(cwd, String(p ?? ".").replace(/^~(?=\/|$)/, home));

function runCommand({ command, timeout_sec }, { cwd, signal }) {
  const limit = Math.min(Number(timeout_sec) || CMD_TIMEOUT, 1800) * 1000;
  return new Promise((done) => {
    let out = "", killedBy = "";
    // own process group, so a timeout or /stop kills the whole command tree
    const p = spawn("bash", ["-lc", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = (why) => {
      killedBy ||= why;
      try { process.kill(-p.pid, "SIGKILL"); } catch {}
    };
    const t = setTimeout(() => kill(`таймаут ${limit / 1000} с`), limit);
    const onAbort = () => kill("остановлено пользователем");
    signal?.addEventListener("abort", onAbort);
    const add = (d) => { if (out.length < OUT_MAX * 4) out += d; };
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    p.on("error", (e) => { out += e.message; });
    // "exit", not "close": background jobs (nohup … &) keep the pipes open, but the command itself has finished
    p.on("exit", (code, sig) => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      setTimeout(() => {
        p.stdout.destroy();
        p.stderr.destroy();
        const head = killedBy ? `[прервано: ${killedBy}]` : `[код выхода: ${code ?? sig}]`;
        done(`${head}\n${out.trim() || "(нет вывода)"}`);
      }, 300);
    });
  });
}

const IMPL = {
  run_command: runCommand,
  read_file({ path, start_line, end_line }, { cwd }) {
    const lines = readFileSync(pathIn(cwd, path), "utf8").split("\n");
    const a = Math.max(1, Number(start_line) || 1), b = Math.min(lines.length, Number(end_line) || lines.length);
    return `${path}: строки ${a}-${b} из ${lines.length}\n` + lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join("\n");
  },
  list_dir({ path }, { cwd }) {
    const dir = pathIn(cwd, path);
    return `${dir}:\n` + readdirSync(dir).sort().map((n) => {
      try {
        const s = statSync(resolve(dir, n));
        return s.isDirectory() ? `${n}/` : `${n} (${s.size} Б)`;
      } catch {
        return n;
      }
    }).join("\n");
  },
  write_file({ path, content }, { cwd }) {
    const f = pathIn(cwd, path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, String(content));
    return `Записан ${f}: ${String(content).split("\n").length} строк, ${String(content).length} символов.`;
  },
  append_file({ path, content }, { cwd }) {
    const f = pathIn(cwd, path);
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, String(content));
    return `Дописано в ${f}: +${String(content).split("\n").length} строк, теперь ${statSync(f).size} Б.`;
  },
  edit_file({ path, old_string, new_string }, { cwd }) {
    const f = pathIn(cwd, path);
    const text = readFileSync(f, "utf8");
    const n = text.split(String(old_string)).length - 1;
    if (n !== 1) return `Ошибка: фрагмент найден ${n} раз(а), нужно ровно 1. Уточни old_string (прочитай файл через read_file).`;
    writeFileSync(f, text.replace(String(old_string), () => String(new_string)));
    return `Изменён ${f}.`;
  },
};

// ---- Lumo API ----
async function complete({ model, think, messages, signal }) {
  const body = { model, messages, tools: TOOLS, stream: false };
  if (think !== undefined) body.reasoning_effort = think ? "high" : "none";
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(REQ_TIMEOUT * 1000);
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`Lumo API ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
      const msg = JSON.parse(text).choices?.[0]?.message;
      if (!msg) throw new Error(`Lumo API: пустой ответ: ${text.slice(0, 300)}`);
      return msg;
    } catch (e) {
      if (signal?.aborted) throw e;
      // one retry on dropped streams ("terminated"), timeouts and 5xx; 4xx are not retried
      if (attempt >= 2 || (e.status && e.status < 500)) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/**
 * One user turn: loops Lumo <-> tools until Lumo answers without tool calls.
 * onText(text)            — Lumo's text (also intermediate, alongside tool calls)
 * onTool(name, args)      — before a tool runs (for the "🔧 …" message)
 * approve(name, args, signal) -> { behavior: "allow" } | { behavior: "deny", message }
 * Returns the last text, for voice replies.
 */
export async function runAgent({ sessionId, system, prompt, cwd, model, think, signal, onText, onTool, approve }) {
  const history = loadHistory(sessionId);
  repair(history);
  history.push({ role: "user", content: prompt });
  let last = "";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const msg = await complete({ model, think, signal, messages: [{ role: "system", content: system }, ...windowOf(history)] });
      const calls = (msg.tool_calls ?? []).filter((c) => c?.function?.name);
      const content = typeof msg.content === "string" ? msg.content.trim() : "";
      if (calls.length) calls.forEach((c, i) => (c.id ||= `call_${Date.now()}_${i}`));
      history.push(calls.length ? { role: "assistant", content: content || null, tool_calls: calls } : { role: "assistant", content });
      if (content) {
        last = content;
        await onText(content);
      }
      if (!calls.length) return last;
      for (const c of calls) {
        const name = c.function.name.replace(/^user:/, "");
        let args, out;
        try {
          args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function.arguments ?? {};
        } catch {
          args = null;
        }
        if (!args) out = "Ошибка: аргументы вызова — некорректный JSON. Повтори вызов с правильным JSON.";
        else if (!IMPL[name]) out = `Ошибка: нет инструмента ${name}. Доступны: ${Object.keys(IMPL).join(", ")}.`;
        else {
          await onTool(name, args);
          const d = SAFE_TOOLS.has(name) ? { behavior: "allow" } : await approve(name, args, signal);
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          try {
            out = d.behavior === "allow" ? await IMPL[name](args, { cwd, signal }) : d.message || "Пользователь запретил это действие.";
          } catch (e) {
            out = `Ошибка: ${e.message}`;
          }
        }
        history.push({ role: "tool", tool_call_id: c.id, content: clip(out) });
        saveHistory(sessionId, history);
      }
    }
    const note = `⚠️ Сделано ${MAX_STEPS} шагов подряд, остановился. Напиши «продолжай», чтобы продолжить.`;
    await onText(note);
    return last;
  } finally {
    repair(history);
    saveHistory(sessionId, history);
  }
}
