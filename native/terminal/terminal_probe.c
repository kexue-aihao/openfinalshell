#include "ofs_terminal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static size_t read_output(ofs_terminal *t, char *out, size_t size) {
  memset(out, 0, size);
  return ofs_terminal_read_output(t, out, size - 1);
}
int main(void) {
  ofs_terminal *t = ofs_terminal_create(4, 24); if (!t) return 2;
  const char *input = "hello\x1b[2;4H\x1b[31mworld\x1b[0m";
  if (ofs_terminal_feed(t, input, strlen(input)) != strlen(input)) return 3;
  char out[256] = {0}; size_t n = ofs_terminal_read_text(t, out, sizeof(out));
  int found = 0;
  for (size_t i = 0; i + 5 <= n; ++i) if (memcmp(out + i, "hello", 5) == 0) { found = 1; break; }
  if (n == 0 || !found) { fprintf(stderr, "VT output missing (%zu)\n", n); return 4; }
  ofs_terminal_cell cell = {0};
  if (!ofs_terminal_get_cell(t, 1, 3, &cell) || cell.codepoint != 'w' || cell.fg_type != 1) { fprintf(stderr, "cell attributes missing\n"); return 5; }
  const char *lines = "\r\nline-1\r\nline-2\r\nline-3\r\nline-4\r\nline-5";
  ofs_terminal_feed(t, lines, strlen(lines));
  if (ofs_terminal_scrollback_lines(t) < 2) { fprintf(stderr, "scrollback missing\n"); return 6; }
  if (!ofs_terminal_get_scrollback_cell(t, ofs_terminal_scrollback_lines(t) - 1, 0, &cell) || cell.codepoint != 'l') { fprintf(stderr, "scrollback cell missing\n"); return 7; }
  char generated[256];
  if (!ofs_terminal_key(t, 5, 0)) return 8; /* VTERM_KEY_UP */
  size_t generated_size = read_output(t, generated, sizeof(generated));
  if (generated_size != 3 || memcmp(generated, "\x1b[A", 3) != 0) { fprintf(stderr, "key encoding mismatch\n"); return 9; }
  if (!ofs_terminal_unichar(t, 0x1f642, 0)) return 10;
  generated_size = read_output(t, generated, sizeof(generated));
  const unsigned char emoji[] = {0xf0, 0x9f, 0x99, 0x82};
  if (generated_size != sizeof(emoji) || memcmp(generated, emoji, sizeof(emoji)) != 0) { fprintf(stderr, "unicode encoding mismatch\n"); return 11; }
  const char *paste_mode = "\x1b[?2004h";
  ofs_terminal_feed(t, paste_mode, strlen(paste_mode));
  if (!ofs_terminal_paste_utf8(t, "中文", strlen("中文"))) return 12;
  generated_size = read_output(t, generated, sizeof(generated));
  const char expected_paste[] = "\x1b[200~中文\x1b[201~";
  if (generated_size != sizeof(expected_paste) - 1 || memcmp(generated, expected_paste, sizeof(expected_paste) - 1) != 0) { fprintf(stderr, "bracketed paste mismatch (%zu)\n", generated_size); return 13; }
  char large_paste[8192]; memset(large_paste, 'x', sizeof(large_paste));
  if (!ofs_terminal_paste_utf8(t, large_paste, sizeof(large_paste))) return 17;
  char *large_output = (char *)malloc(sizeof(large_paste) + 32);
  if (!large_output) return 18;
  generated_size = ofs_terminal_read_output(t, large_output, sizeof(large_paste) + 32);
  int large_ok = generated_size == sizeof(large_paste) + 12 &&
    memcmp(large_output, "\x1b[200~", 6) == 0 &&
    memcmp(large_output + 6, large_paste, sizeof(large_paste)) == 0 &&
    memcmp(large_output + 6 + sizeof(large_paste), "\x1b[201~", 6) == 0;
  free(large_output);
  if (!large_ok) { fprintf(stderr, "large paste was truncated (%zu)\n", generated_size); return 19; }
  if (ofs_terminal_paste_utf8(t, large_paste, 4 * 1024 * 1024 + 1) != 0 || ofs_terminal_take_output_error(t) != 0) return 20;
  ofs_terminal *unicode_cells = ofs_terminal_create(2, 16);
  if (!unicode_cells) return 21;
  const char *wide_text = "欢A";
  if (ofs_terminal_feed(unicode_cells, wide_text, strlen(wide_text)) != strlen(wide_text)) return 22;
  uint32_t codepoints[16] = {0};
  ofs_terminal_cell first = {0};
  int first_count = ofs_terminal_get_cell_codepoints(unicode_cells, 0, 0, codepoints, 16);
  if (!ofs_terminal_get_cell(unicode_cells, 0, 0, &first) || first_count != 1 || codepoints[0] != 0x6B22u || first.width != 2) {
    fprintf(stderr, "wide cell codepoints invalid: count=%d cp=%u width=%u\n", first_count, codepoints[0], first.width);
    return 23;
  }
  ofs_terminal_cell continuation = {0};
  int continuation_count = ofs_terminal_get_cell_codepoints(unicode_cells, 0, 1, codepoints, 16);
  if (!ofs_terminal_get_cell(unicode_cells, 0, 1, &continuation)) return 24;
  if (continuation_count != 1 || codepoints[0] != 0xFFFFFFFFu || continuation.width != 1) return 24;
  if (!ofs_terminal_get_cell(unicode_cells, 0, 2, &first) || first.codepoint != 'A') return 25;
  ofs_terminal_destroy(unicode_cells);
  const char *mouse_mode = "\x1b[?1000h";
  ofs_terminal_feed(t, mouse_mode, strlen(mouse_mode));
  if (ofs_terminal_mouse_mode(t) == 0 || !ofs_terminal_mouse_move(t, 1, 2, 0) || !ofs_terminal_mouse_button(t, 1, 1, 0)) return 14;
  generated_size = read_output(t, generated, sizeof(generated));
  if (generated_size < 1) { fprintf(stderr, "mouse protocol emitted no data\n"); return 15; }
  const char *alternate = "\x1b[?1049h";
  ofs_terminal_feed(t, alternate, strlen(alternate));
  if (!ofs_terminal_alt_screen(t)) { fprintf(stderr, "alternate screen state missing\n"); return 16; }
  printf("terminal probe passed; cursor=%d,%d; bytes=%zu\n", ofs_terminal_cursor_row(t), ofs_terminal_cursor_col(t), n);
  ofs_terminal_destroy(t); return 0;
}
