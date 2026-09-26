/**
 * Minimal TOML-subset parser for Synergon config files.
 * Supports [sections], string/number/boolean/array values, # comments.
 * Deliberately small — full TOML is out of scope for v1; malformed input throws.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue | TomlTable;
}const SECTION_RE = /^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]\s*$/;
const ARRAY_SECTION_RE = /^\s*\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]\s*$/;
const KV_RE =
  /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/;

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;

  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const lineNo = i + 1;
    const line = raw.replace(/(^|\s)#.*$/, "").trim(); // strip comments
    if (!line) continue;

    const arraySection = ARRAY_SECTION_RE.exec(line);
    if (arraySection) {
      // [[a.b.c]] — append a fresh table to the array at `path`, resolved from
      // the ROOT (like [a.b.c] sections). Intermediate segments that are
      // arrays resolve to their most recent entry, so [[skill.checklist]]
      // attaches to the last [[skill]] entry and repeated [[a.b]] entries
      // each become siblings — never nested inside the previous one.
      const parts = arraySection[1]!.split(".");
      let cursor: TomlTable = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]!;
        const next = cursor[key];
        if (next === undefined) {
          const fresh: TomlTable = {};
          cursor[key] = fresh;
          cursor = fresh;
        } else if (Array.isArray(next)) {
          const last = next[next.length - 1];
          if (typeof last !== "object" || last === null || Array.isArray(last)) {
            throw new Error(`config line ${lineNo}: [[${arraySection[1]}]] conflicts with earlier value`);
          }
          cursor = last as TomlTable;
        } else if (typeof next === "object") {
          cursor = next as TomlTable;
        } else {
          throw new Error(`config line ${lineNo}: [[${arraySection[1]}]] conflicts with earlier value`);
        }
      }
      const lastKey = parts[parts.length - 1]!;
      const arr = cursor[lastKey];
      if (arr === undefined) {
        const fresh: TomlTable = {};
        cursor[lastKey] = [fresh];
        current = fresh;
      } else if (Array.isArray(arr)) {
        const fresh: TomlTable = {};
        arr.push(fresh);
        current = fresh;
      } else {
        throw new Error(`config line ${lineNo}: [[${arraySection[1]}]] conflicts with earlier value`);
      }
      continue;
    }

    const section = SECTION_RE.exec(line);
    if (section) {
      current = root;
      for (const part of section[1]!.split(".")) {
        const next = current[part];
        if (next === undefined) {
          const fresh: TomlTable = {};
          current[part] = fresh;
          current = fresh;
        } else if (Array.isArray(next)) {
          // TOML: [a.b.c] where `b` is an array-of-tables targets the LAST
          // element (e.g. [mcp.servers.env] after [[mcp.servers]]).
          const last = next[next.length - 1];
          if (typeof last !== "object" || last === null || Array.isArray(last)) {
            throw new Error(`config line ${lineNo}: [${section[1]}] conflicts with earlier value`);
          }
          current = last as TomlTable;
        } else if (typeof next === "object") {
          current = next as TomlTable;
        } else {
          throw new Error(`config line ${lineNo}: [${section[1]}] conflicts with earlier value`);
        }
      }
      continue;
    }

    const kv = KV_RE.exec(line);
    if (!kv) throw new Error(`config line ${lineNo}: cannot parse "${raw.trim()}"`);
    current[kv[1]!] = parseValue(kv[2]!, lineNo);
  }
  return root;
}

function parseValue(raw: string, lineNo: number): TomlValue {
  if (raw.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) throw new Error(`config line ${lineNo}: unterminated string`);
    return raw.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) throw new Error(`config line ${lineNo}: unterminated array`);
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((p) => {
      const v = p.trim();
      if (!v) throw new Error(`config line ${lineNo}: empty array element`);
      if (v.startsWith('"')) {
        if (!/^"(?:[^"\\]|\\.)*"$/.test(v)) throw new Error(`config line ${lineNo}: bad string in array`);
        return v.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
      }
      const n = Number(v);
      if (Number.isFinite(n) && v !== "") return n;
      if (v === "true") return true;
      if (v === "false") return false;
      throw new Error(`config line ${lineNo}: unsupported array element "${v}"`);
    });
  }
  const num = Number(raw);
  if (Number.isFinite(num) && raw !== "") return num;
  throw new Error(`config line ${lineNo}: unsupported value "${raw}"`);
}
