// Freeze the first page's head so a download cannot mix different world revisions.
export async function fetchSnapshot(bounds, readPage, requestedHead, signal) {
  let after = 0,
    head = requestedHead;
  const events = [];
  for (let page = 0; page < 2000; page++) {
    signal?.throwIfAborted();
    const q = new URLSearchParams(
      Object.entries(bounds).map(([k, v]) => [k, String(v)]),
    );
    q.set("after", String(after));
    if (head !== undefined) q.set("head", String(head));
    const data = await readPage(q);
    signal?.throwIfAborted();
    if (head !== undefined && data.head !== head)
      throw new Error("Snapshot changed. Try again.");
    head = data.head;
    events.push(...data.events);
    if (data.events.length < 100) return { head, events };
    const next = data.events.at(-1).seq;
    if (next <= after || next > head)
      throw new Error("Invalid snapshot cursor.");
    after = next;
  }
  throw Object.assign(
    new Error(
      "This region has too much history to load. Select a smaller view.",
    ),
    { terminal: true },
  );
}
