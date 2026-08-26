/**
 * A run quotes terminal output verbatim, escape bytes and all. Markdown draws an escape as a
 * missing glyph and reads the bracket behind it as the start of a link that never closes.
 */
const SEQUENCE =
  /[\x1B\x9B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\x07)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** What a half written sequence leaves behind. A tab and a newline are the two the transcript keeps. */
const CONTROL = /[\x00-\x08\x0B-\x1F\x7F\x9B]/g;

export function plain(value: string): string {
  return value.replace(SEQUENCE, "").replace(CONTROL, "");
}
