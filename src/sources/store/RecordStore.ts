import crypto from "crypto";
import fs from "fs-extra";
import * as path from "path";
import { SnapshotManifest } from "./SnapshotManifest.ts";
import { withRetry } from "../Retry.ts";

// Source data is stored one record (an action, a tx) per file, and a record that comes back different is
// stored again as a new copy, never overwritten. A run picks one copy of each record by rules (the good
// copy over a pruned one, a finalised copy over a pending one) and lists the copies it used in its
// manifest, so it can be replayed exactly. See docs/specs/snapshots.md.
//
//   <storePath>/records/<source>/<yyyy>/<mm>/<key>.0.json   a record's first copy; .1 the next, ...
//   <storePath>/lists/<source>/<wallet>.0.json                the record keys one fetch of a wallet returned
//
// The key is in the file name (encoded), so one scan of the names finds every copy. Copies are ordered by
// fetchedAt (unknown, for copies imported from old caches, sorts first), then by number.

export type FetchMode = "latest" | "all";

export interface StoreOptions {
  // Only read stored records. Anything not stored is an error instead of a fetch.
  offline?: boolean;
  // What to fetch, besides anything not stored yet (docs/specs/snapshots.md):
  // latest (default): every wallet list again, and records still pending; all: every record again too
  fetch?: FetchMode;
  // Read exactly the copies an earlier run used (its snapshots.json). Implies offline.
  replay?: SnapshotManifest;
  // Records every copy this run uses
  manifest?: SnapshotManifest;
  // A record still pending this many days after its date is stuck: a default run stops fetching it again.
  // Default: always fetched again
  pendingStuckDays?: number;
  // The run's date, to tell a stuck record. Default: now
  today?: Date;
}

export interface Fetched<T> {
  data: T;
  url?: string;
  // A list the source returned short (e.g. fewer records than the total it reports): why, kept with the stored list
  incomplete?: string;
}

// How a source's records are filed and compared
export interface RecordRules<T = any> {
  // Not final yet, e.g. a Midgard action with status 'pending'
  isPending?: (data: T) => boolean;
  // More is better; a copy with less (e.g. a THORNode tx pruned of its gas) is not used
  completeness?: (data: T) => number;
  // Drops what changes on every fetch but is not source data (e.g. a value at today's price), before
  // a copy is compared and stored
  normalise?: (data: T) => T;
  // The folder of a new record: its month 'yyyy/mm' (monthFolder), from its own date. A record with no
  // date of its own (a THORNode tx status) takes the date of the action it was fetched for, or 'undated'.
  folderOf?: (data: T) => string | undefined;
  // Whose record it is (e.g. an action's addresses). A fetched copy that shares none with the stored copy is
  // another member's record under the same key, not a new version of it: an error, not a new copy.
  membersOf?: (data: T) => string[];
}

export interface RecordOptions {
  // A best-effort source: a failed fetch of a record already stored is passed to this instead of failing the run,
  // which carries on with the stored copy. With none stored, the error is thrown. It may rethrow.
  onFetchError?: (error: unknown) => void;
}

export interface ListOptions<T> {
  keyOf: (item: T) => string;
  rules?: RecordRules<T>;
  // What the source lists does not change (e.g. Viewblock's sends from before 2022-04): once a complete list of the
  // wallet is stored, it is fetched again only by fetch 'all'. A stored list marked incomplete is fetched again.
  fetchOnce?: boolean;
  // Called on every run that uses a list stored as incomplete (fetched now, stored earlier or replayed), with why
  onIncomplete?: (incomplete: string) => void;
  // A best-effort source: a failed fetch is passed to this instead of failing the run, which carries on with the
  // stored lists of the wallet (none: an empty list). stored: whether there are any. It may rethrow.
  onFetchError?: (error: unknown, stored: boolean) => void;
}

// What a fetch did: the record's first copy, a new copy, or the same as the latest copy
type FetchStatus = "new" | "changed" | "unchanged";

interface Stored<T> {
  copy: Copy<T>;
  status: FetchStatus;
}

export interface Origin {
  fetchedAt: string | null;
  url?: string;
  // Where an imported copy came from (an old cache file)
  importedFrom?: string;
}

export interface Copy<T = any> extends Origin {
  file: string;
  n: number;
  sha256: string;
  data: T;
}

interface List extends Origin {
  file: string;
  n: number;
  keys: string[];
  incomplete?: string;
}

// Why a copy is used
export type Choice = "only" | "finalised" | "revised" | "kept-over-pruned";

export class StoreMissError extends Error {
  constructor(what: string) {
    super(`Offline: nothing stored for ${what}`);
    this.name = "StoreMissError";
  }
}

export function sha256(data: any): string {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

// A key as a file name: letters, digits and . _ + - are kept, anything else is %XX (UTF-8), so the name
// decodes back to the key and is safe on every file system
export function encodeName(key: string): string {
  return key.replace(/[^A-Za-z0-9._+-]/g, (char) =>
    [...Buffer.from(char)].map((byte) => "%" + byte.toString(16).toUpperCase().padStart(2, "0")).join(""),
  );
}

export function decodeName(name: string): string {
  return decodeURIComponent(name);
}

// <key>.<n>.json: the copy number is always the last number, so a key may itself end in one (TCY's date)
const COPY_FILE = /^(.+)\.(\d+)\.json$/;

// 'yyyy/mm' (UTC): the folder of a record
export function monthFolder(date: Date): string {
  return date.toISOString().slice(0, 7).replace("-", "/");
}

// Picks the copy to use: copies oldest first, each later one replaces the choice unless it has less in it.
// Copies that differ only in what the source's normalise drops (stored before it was added) count as the same.
export function chooseCopy<T>(
  copies: Copy<T>[],
  rules: RecordRules<T> = {},
): { copy: Copy<T>; choice: Choice; ignored: Copy<T>[] } {
  const completeness = rules.completeness ?? (() => 0);
  const isPending = rules.isPending ?? (() => false);
  const same = (a: Copy<T>, b: Copy<T>) =>
    a.sha256 === b.sha256 || (!!rules.normalise && sha256(rules.normalise(a.data)) === sha256(rules.normalise(b.data)));
  let copy = copies[0];
  let choice: Choice = "only";
  const ignored: Copy<T>[] = [];

  for (const next of copies.slice(1)) {
    if (same(next, copy)) {
      continue;
    }

    if (completeness(next.data) < completeness(copy.data)) {
      ignored.push(next);
      choice = "kept-over-pruned";
    } else {
      choice = isPending(copy.data) && !isPending(next.data) ? "finalised" : "revised";
      copy = next;
    }
  }

  return { copy, choice, ignored };
}

// Addresses compared case-insensitively; a record with none (e.g. a placeholder) matches anything
function sharesMember(a: string[], b: string[]): boolean {
  const lower = new Set(a.map((address) => address.toLowerCase()));
  return a.length === 0 || b.length === 0 || b.some((address) => lower.has(address.toLowerCase()));
}

// Oldest first: by fetch time (unknown first), then by number
function byAge(a: Origin & { n: number }, b: Origin & { n: number }): number {
  return (a.fetchedAt ?? "").localeCompare(b.fetchedAt ?? "") || a.n - b.n;
}

export class RecordStore {
  readonly offline: boolean;
  private readonly fetchMode: FetchMode;
  private readonly replay?: SnapshotManifest;
  private readonly manifest?: SnapshotManifest;
  private readonly stuckBefore?: Date;
  // Records and lists fetched in this run: one shared by several wallets is fetched once
  private readonly fetchedThisRun = new Set<string>();
  // File names under records/<source> or lists/<source>, by key; built on first use
  private readonly index = new Map<string, Map<string, string[]>>();

  readonly root: string;
  constructor(root: string, options: StoreOptions = {}) {
    this.root = root;
    this.replay = options.replay;
    this.offline = (options.offline ?? false) || !!options.replay;
    this.fetchMode = options.fetch ?? "latest";
    this.manifest = options.manifest;
    if (options.pendingStuckDays !== undefined) {
      this.stuckBefore = new Date((options.today ?? new Date()).getTime() - options.pendingStuckDays * 86400_000);
    }
  }

  // Replaying a run that read nothing from this source (one added since): it gives that run nothing
  addedSinceReplay(source: string): boolean {
    return !!this.replay && !this.replay.hasSource(source);
  }

  // A best-effort source (Viewblock) could not give the record: the manifest says so, and a replay gives nothing
  recordSkipped(source: string, key: string) {
    this.manifest?.recordSkipped(source, key);
  }

  // Replaying a run that could not fetch the record (recordSkipped): it gives nothing, as it gave that run
  skippedInReplay(source: string, key: string): boolean {
    if (this.replay?.isSkipped(source, key)) {
      this.manifest?.recordSkipped(source, key);
      return true;
    }

    return false;
  }

  // One record, e.g. a THORNode tx. date: when the record started (e.g. the date of the action it belongs
  // to), for filing a record with no date of its own
  async record<T>(
    source: string,
    key: string,
    fetch: () => Promise<Fetched<T>>,
    rules: RecordRules<T> = {},
    date?: Date,
    options: RecordOptions = {},
  ): Promise<T> {
    if (this.replay) {
      return this.replayRecord(source, key);
    }

    let fetchedNow: Stored<T> | undefined;

    if (this.shouldFetchRecord(source, key, rules, date)) {
      this.assertCanFetch(`${source} ${key}`);
      let fetched: Fetched<T> | undefined;

      try {
        fetched = await withRetry(fetch, `${source} ${key}`);
      } catch (error) {
        if (!options.onFetchError || this.copies<T>(source, key).length === 0) {
          throw error;
        }

        options.onFetchError(error);
      }

      if (fetched) {
        fetchedNow = this.store(
          source,
          key,
          fetched.data,
          rules,
          { fetchedAt: new Date().toISOString(), url: fetched.url },
          date,
        );
      }
    }

    return this.use(source, key, rules, fetchedNow);
  }

  // A wallet's records, e.g. its Midgard actions. Records that an earlier fetch returned and a later one
  // didn't are kept, and flagged as missing from the source.
  async list<T>(
    source: string,
    wallet: string,
    fetch: () => Promise<Fetched<T[]>>,
    options: ListOptions<T>,
  ): Promise<T[]> {
    const rules = options.rules ?? {};

    if (this.replay) {
      const list = this.replay.findList(source, wallet);

      // A source added after the replayed run gave it nothing
      if (!list && !this.replay.hasSource(source)) {
        return [];
      }

      if (!list) {
        throw new StoreMissError(`${source} list ${wallet} in the replayed run`);
      }

      this.manifest?.recordList(list);

      if (list.incomplete) {
        options.onIncomplete?.(list.incomplete);
      }

      return list.keys.map((key) => this.replayRecord(source, key));
    }

    let fetchedNow = new Map<string, Stored<T>>();

    if (this.shouldFetchList(source, wallet, options.fetchOnce)) {
      this.assertCanFetch(`${source} list ${wallet}`);
      let fetched: Fetched<T[]> | undefined;

      try {
        fetched = await withRetry(fetch, `${source} list ${wallet}`);
      } catch (error) {
        if (!options.onFetchError) {
          throw error;
        }

        options.onFetchError(error, this.lists(source, wallet).length > 0);
      }

      if (fetched) {
        fetchedNow = this.storeList(source, wallet, fetched.data, options, fetched.incomplete, {
          fetchedAt: new Date().toISOString(),
          url: fetched.url,
        });
      }
    }

    const lists = this.lists(source, wallet);
    const latest = lists[lists.length - 1]?.keys ?? [];
    const incomplete = lists[lists.length - 1]?.incomplete;
    // A record whose key has since changed (the key rule for its shape was refined) is in the latest list under
    // its new key, so it is not missing
    const renamed = (key: string) =>
      this.copies<T>(source, key).some((copy) => latest.includes(options.keyOf(copy.data)));
    const earlier = [...new Set(lists.slice(0, -1).flatMap((list) => list.keys))].filter(
      (key) => !latest.includes(key) && !renamed(key),
    );
    const keys = [...latest, ...earlier];

    this.manifest?.recordList({
      source,
      wallet,
      keys,
      missing: earlier,
      file: this.relative(lists[lists.length - 1]?.file),
      ...(incomplete ? { incomplete } : {}),
    });

    if (incomplete) {
      options.onIncomplete?.(incomplete);
    }

    return keys.map((key) => this.use(source, key, rules, fetchedNow.get(key), earlier.includes(key)));
  }

  // A record not stored yet is always fetched, and one still pending is fetched again, as it may since be
  // finalised, unless it is stuck (pending since before the cut-off; THORNode reports a tx it pruned as not
  // yet observed). A finalised or stuck one is fetched again by 'all'. date: of the action the record belongs to
  private shouldFetchRecord<T>(source: string, key: string, rules: RecordRules<T>, date?: Date): boolean {
    const copies = this.copies<T>(source, key);

    if (this.offline) {
      return copies.length === 0;
    }

    const wanted =
      copies.length === 0 ||
      this.fetchMode === "all" ||
      (!!rules.isPending?.(chooseCopy(copies, rules).copy.data) && !this.isStuck(date));

    return wanted && this.firstFetchThisRun(`records/${source}/${key}`);
  }

  // A wallet's list is fetched again on every run that isn't offline, for new activity and changed records; one
  // fetched once is fetched again only by 'all', or while its latest stored list is incomplete
  private shouldFetchList(source: string, wallet: string, fetchOnce = false): boolean {
    const lists = this.lists(source, wallet);

    if (this.offline) {
      return lists.length === 0;
    }

    if (fetchOnce && this.fetchMode !== "all" && lists.length > 0 && !lists[lists.length - 1].incomplete) {
      return false;
    }

    return this.firstFetchThisRun(`lists/${source}/${wallet}`);
  }

  private isStuck(date?: Date): boolean {
    return !!date && !!this.stuckBefore && date < this.stuckBefore;
  }

  private firstFetchThisRun(id: string): boolean {
    if (this.fetchedThisRun.has(id)) {
      return false;
    }

    this.fetchedThisRun.add(id);
    return true;
  }

  // Adds a copy from an old cache or store, unless the same copy (after normalising) is already stored
  importCopy<T>(source: string, key: string, data: T, rules: RecordRules<T>, origin: Origin, date?: Date): boolean {
    const normalised = rules.normalise ? rules.normalise(data) : data;
    const hash = sha256(normalised);
    const same = (copy: Copy<T>) => (rules.normalise ? sha256(rules.normalise(copy.data)) : copy.sha256) === hash;

    if (this.copies<T>(source, key).some(same)) {
      return false;
    }

    this.writeCopy(source, key, normalised, hash, rules, origin, date);
    return true;
  }

  // Adds what one old fetch of a wallet returned, unless a stored list has the same keys
  importList(source: string, wallet: string, keys: string[], origin: Origin): boolean {
    if (this.lists(source, wallet).some((list) => JSON.stringify(list.keys) === JSON.stringify(keys))) {
      return false;
    }

    this.writeList(source, wallet, keys, origin);
    return true;
  }

  assertCanFetch(what: string) {
    if (this.offline) {
      throw new StoreMissError(what);
    }
  }

  // Every record key stored for a source
  keys(source: string): string[] {
    return [...this.files("records", source).keys()];
  }

  // All stored copies of a record, oldest first
  copies<T>(source: string, key: string): Copy<T>[] {
    return (this.files("records", source).get(key) ?? [])
      .map((file) => ({ ...fs.readJSONSync(file), file, n: copyNumber(file) }))
      .sort(byAge);
  }

  private lists(source: string, wallet: string): List[] {
    return (this.files("lists", source).get(wallet) ?? [])
      .map((file) => ({ ...fs.readJSONSync(file), file, n: copyNumber(file) }))
      .sort(byAge);
  }

  private use<T>(source: string, key: string, rules: RecordRules<T>, fetchedNow?: Stored<T>, missing = false): T {
    const copies = this.copies<T>(source, key);

    if (copies.length === 0) {
      throw new StoreMissError(`${source} ${key}`);
    }

    const { copy, choice, ignored } = chooseCopy(copies, rules);

    if (fetchedNow && ignored.some((c) => c.sha256 === fetchedNow.copy.sha256)) {
      console.log(
        `[Store] ${source} ${key}: fetched a copy with less in it (pruned?); using the copy of ${copy.fetchedAt ?? "the first fetch"}`,
      );
    }

    this.manifest?.recordRecord({
      source,
      key,
      file: this.relative(copy.file),
      fetchedAt: copy.fetchedAt,
      url: copy.url,
      sha256: copy.sha256,
      choice,
      copies: copies.length,
      ...(missing ? { missing: true } : {}),
      ...(fetchedNow ? { fetched: fetchedNow.status } : {}),
    });

    return copy.data;
  }

  private replayRecord<T>(source: string, key: string): T {
    const entry = this.replay!.findRecord(source, key);

    if (!entry) {
      throw new StoreMissError(`${source} ${key} in the replayed run`);
    }

    const copy: Copy<T> = fs.readJSONSync(path.join(this.root, entry.file));

    if (copy.sha256 !== entry.sha256) {
      throw new Error(
        `Replay: ${entry.file} does not match the manifest (sha256 ${copy.sha256}, expected ${entry.sha256})`,
      );
    }

    this.manifest?.recordRecord({ ...entry });

    return copy.data;
  }

  // Stores a copy unless it is the same as the latest stored copy
  private store<T>(
    source: string,
    key: string,
    fetchedData: T,
    rules: RecordRules<T>,
    origin: Origin,
    date?: Date,
  ): Stored<T> {
    const data = rules.normalise ? rules.normalise(fetchedData) : fetchedData;
    const hash = sha256(data);
    const copies = this.copies<T>(source, key);
    const latest = copies[copies.length - 1];

    if (latest?.sha256 === hash) {
      return { copy: latest, status: "unchanged" };
    }

    if (latest && rules.membersOf && !sharesMember(rules.membersOf(latest.data), rules.membersOf(data))) {
      throw new Error(
        `${source} ${key}: the fetched record belongs to other addresses than the stored copy ` +
          `(${this.relative(latest.file)}), so two records have one key; it was not stored`,
      );
    }

    return { copy: this.writeCopy(source, key, data, hash, rules, origin, date), status: latest ? "changed" : "new" };
  }

  private storeList<T>(
    source: string,
    wallet: string,
    items: T[],
    { keyOf, rules = {} }: ListOptions<T>,
    incomplete: string | undefined,
    origin: Origin,
  ): Map<string, Stored<T>> {
    const stored = new Map<string, Stored<T>>();

    for (const item of items) {
      const key = keyOf(item);

      if (stored.has(key)) {
        throw new Error(`${source} ${wallet}: two records with the key ${key}`);
      }

      stored.set(key, this.store(source, key, item, rules, origin));
    }

    const keys = [...stored.keys()];
    const latest = this.lists(source, wallet).at(-1);

    // The same keys, but now complete (or now short), is a new list too
    if (JSON.stringify(latest?.keys) !== JSON.stringify(keys) || latest?.incomplete !== incomplete) {
      this.writeList(source, wallet, keys, origin, incomplete);
    }

    return stored;
  }

  // A new copy goes next to the record's first copy (so a revision that changes its date doesn't move it),
  // or for a new record in its month, numbered one after the highest stored
  private writeCopy<T>(
    source: string,
    key: string,
    data: T,
    hash: string,
    rules: RecordRules<T>,
    origin: Origin,
    date?: Date,
  ): Copy<T> {
    const files = this.files("records", source).get(key) ?? [];
    const first = [...files].sort((a, b) => copyNumber(a) - copyNumber(b))[0];
    const folder = rules.folderOf?.(data) || (date ? monthFolder(date) : "undated");
    const dir = first ? path.dirname(first) : path.join(this.root, "records", source, folder);
    const content = { source, key, ...originFields(origin), sha256: hash, data };
    const { file, n } = this.writeNew("records", source, key, dir, files, content);

    return { ...content, file, n } as Copy<T>;
  }

  private writeList(source: string, wallet: string, keys: string[], origin: Origin, incomplete?: string) {
    const files = this.files("lists", source).get(wallet) ?? [];
    this.writeNew("lists", source, wallet, path.join(this.root, "lists", source), files, {
      source,
      wallet,
      ...originFields(origin),
      ...(incomplete ? { incomplete } : {}),
      keys,
    });
  }

  // Creates <key>.<n>.json with the next free number; never overwrites a file, even one another run is writing
  private writeNew(
    kind: string,
    source: string,
    key: string,
    dir: string,
    files: string[],
    content: any,
  ): { file: string; n: number } {
    fs.mkdirpSync(dir);
    let n = files.reduce((max, file) => Math.max(max, copyNumber(file) + 1), 0);

    for (; ; n++) {
      const file = path.join(dir, `${encodeName(key)}.${n}.json`);
      let fd: number;

      try {
        fd = fs.openSync(file, "wx");
      } catch (error: any) {
        if (error.code === "EEXIST") {
          continue;
        }
        throw error;
      }

      fs.writeSync(fd, JSON.stringify(content, null, 2) + "\n");
      fs.closeSync(fd);
      this.files(kind, source).set(key, [...files, file]);

      return { file, n };
    }
  }

  // Every copy file under records/<source> (or lists/<source>), by the key in its name
  private files(kind: string, source: string): Map<string, string[]> {
    const id = `${kind}/${source}`;
    let byKey = this.index.get(id);

    if (!byKey) {
      byKey = new Map();
      const lowerCase = new Map<string, string>();

      for (const file of walk(path.join(this.root, kind, source))) {
        const match = path.basename(file).match(COPY_FILE);

        if (!match) {
          continue;
        }

        const key = decodeName(match[1]);
        const clash = lowerCase.get(key.toLowerCase());

        if (clash !== undefined && clash !== key) {
          throw new Error(
            `${id}: the keys ${clash} and ${key} differ only in case, which some file systems can't tell apart`,
          );
        }

        lowerCase.set(key.toLowerCase(), key);
        byKey.set(key, [...(byKey.get(key) ?? []), file]);
      }

      this.index.set(id, byKey);
    }

    return byKey;
  }

  private relative(file?: string): string {
    return file ? path.relative(this.root, file) : "";
  }
}

function copyNumber(file: string): number {
  return Number(path.basename(file).match(COPY_FILE)?.[2] ?? -1);
}

function originFields(origin: Origin): Origin {
  return {
    fetchedAt: origin.fetchedAt,
    ...(origin.url ? { url: origin.url } : {}),
    ...(origin.importedFrom ? { importedFrom: origin.importedFrom } : {}),
  };
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}
