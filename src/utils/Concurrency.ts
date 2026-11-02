// fn over the items, at most `limit` at a time; the results are in the items' order. After an error no more items
// are started, and the first error is thrown once the ones already started have finished.
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;

      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");

  if (rejected) {
    throw rejected.reason;
  }

  return results;
}
