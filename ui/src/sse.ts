// Splits a server-sent event stream into events. POST /api/runs is a POST, so
// EventSource cannot read it. Chunks can end anywhere, so text after the last
// blank line waits for the next chunk.
export function createEventParser(onEvent: (event: string, data: unknown) => void) {
  let buffer = '';

  return (chunk: string) => {
    buffer += chunk;
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop()!;

    for (const block of blocks) {
      let event = 'message';
      const data: string[] = [];

      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
          data.push(line.slice('data: '.length));
        }
      }

      if (data.length > 0) {
        onEvent(event, JSON.parse(data.join('\n')));
      }
    }
  };
}
