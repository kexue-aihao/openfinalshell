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
  ofs_terminal *layout_cells = ofs_terminal_create(5, 32);
  if (!layout_cells) return 40;
  const char *layout_text = "中A\r\n█─\r\nA\xCC\x81" "B\r\n\xF0\x9F\x99\x82" "C\r\n\tZ";
  if (ofs_terminal_feed(layout_cells, layout_text, strlen(layout_text)) != strlen(layout_text)) return 41;
  if (!ofs_terminal_get_cell(layout_cells, 0, 0, &first) || first.codepoint != 0x4E2Du || first.width != 2) return 42;
  if (!ofs_terminal_get_cell(layout_cells, 0, 2, &first) || first.codepoint != 'A') return 42;
  if (!ofs_terminal_get_cell(layout_cells, 1, 0, &first) || first.codepoint != 0x2588u || first.width != 1) return 43;
  if (!ofs_terminal_get_cell(layout_cells, 1, 1, &first) || first.codepoint != 0x2500u || first.width != 1) return 43;
  int combined_count = ofs_terminal_get_cell_codepoints(layout_cells, 2, 0, codepoints, 16);
  if (!ofs_terminal_get_cell(layout_cells, 2, 0, &first) || combined_count != 2 ||
      codepoints[0] != 'A' || codepoints[1] != 0x0301u || first.width != 1) return 44;
  if (!ofs_terminal_get_cell(layout_cells, 3, 0, &first) || first.codepoint != 0x1F642u || first.width != 2) return 45;
  if (!ofs_terminal_get_cell(layout_cells, 3, 2, &first) || first.codepoint != 'C') return 45;
  if (!ofs_terminal_get_cell(layout_cells, 4, 8, &first) || first.codepoint != 'Z') return 46;
  ofs_terminal_destroy(layout_cells);
  ofs_terminal *wide_run_cells = ofs_terminal_create(1, 16);
  if (!wide_run_cells) return 47;
  const char *wide_run_text = "低风险A";
  if (ofs_terminal_feed(wide_run_cells, wide_run_text, strlen(wide_run_text)) != strlen(wide_run_text)) return 48;
  if (!ofs_terminal_get_cell(wide_run_cells, 0, 0, &first) || first.codepoint != 0x4F4Eu || first.width != 2) return 49;
  if (!ofs_terminal_get_cell(wide_run_cells, 0, 2, &first) || first.codepoint != 0x98CEu || first.width != 2) return 49;
  if (!ofs_terminal_get_cell(wide_run_cells, 0, 4, &first) || first.codepoint != 0x9669u || first.width != 2) return 49;
  if (!ofs_terminal_get_cell(wide_run_cells, 0, 6, &first) || first.codepoint != 'A') return 49;
  ofs_terminal_destroy(wide_run_cells);
  ofs_terminal *background_run_cells = ofs_terminal_create(1, 16);
  if (!background_run_cells) return 50;
  const char *background_run_text = "\x1b[42m解锁\x1b[0m";
  if (ofs_terminal_feed(background_run_cells, background_run_text, strlen(background_run_text)) != strlen(background_run_text)) return 51;
  ofs_terminal_cell background_first = {0}, background_continuation = {0}, background_second = {0};
  if (!ofs_terminal_get_cell(background_run_cells, 0, 0, &background_first) || background_first.width != 2) return 52;
  if (!ofs_terminal_get_cell(background_run_cells, 0, 1, &background_continuation) ||
      background_continuation.codepoint != 0xFFFFFFFFu) return 52;
  if (!ofs_terminal_get_cell(background_run_cells, 0, 2, &background_second) || background_second.width != 2) return 52;
  if (background_first.bg_type != background_second.bg_type ||
      background_first.bg_index != background_second.bg_index) return 53;
  ofs_terminal_destroy(background_run_cells);
  const char *mouse_mode = "\x1b[?1000h";
  ofs_terminal_feed(t, mouse_mode, strlen(mouse_mode));
  if (ofs_terminal_mouse_mode(t) == 0 || !ofs_terminal_mouse_move(t, 1, 2, 0) || !ofs_terminal_mouse_button(t, 1, 1, 0)) return 14;
  generated_size = read_output(t, generated, sizeof(generated));
  if (generated_size < 1) { fprintf(stderr, "mouse protocol emitted no data\n"); return 15; }
  ofs_terminal *pasteMode = ofs_terminal_create(2, 20);
  if (!pasteMode || ofs_terminal_bracketed_paste(pasteMode)) return 34;
  const char *paste_enable_a = "\x1b[?20";
  const char *paste_enable_b = "04h";
  ofs_terminal_feed(pasteMode, paste_enable_a, strlen(paste_enable_a));
  if (ofs_terminal_bracketed_paste(pasteMode)) return 35;
  ofs_terminal_feed(pasteMode, paste_enable_b, strlen(paste_enable_b));
  if (!ofs_terminal_bracketed_paste(pasteMode)) return 36;
  const char *paste_disable = "\x1b[?2004l";
  ofs_terminal_feed(pasteMode, paste_disable, strlen(paste_disable));
  if (ofs_terminal_bracketed_paste(pasteMode)) return 37;
  if (!ofs_terminal_paste_utf8(pasteMode, "echo", 4)) return 38;
  generated_size = read_output(pasteMode, generated, sizeof(generated));
  if (generated_size != 4 || memcmp(generated, "echo", 4) != 0) return 39;
  ofs_terminal_destroy(pasteMode);
  const char *alternate = "\x1b[?1049h";
  ofs_terminal_feed(t, alternate, strlen(alternate));
  if (!ofs_terminal_alt_screen(t)) { fprintf(stderr, "alternate screen state missing\n"); return 16; }
  ofs_terminal *history = ofs_terminal_create(2, 20);
  if (!history || !ofs_terminal_set_scrollback_limit(history, 3)) return 26;
  const char *history_lines = "first\r\nsecond\r\nthird\r\nfourth\r\nfifth";
  ofs_terminal_feed(history, history_lines, strlen(history_lines));
  if (ofs_terminal_scrollback_lines(history) != 3) return 27;
  if (!ofs_terminal_resize(history, 2, 30) || ofs_terminal_scrollback_lines(history) != 3) return 28;
  if (!ofs_terminal_get_scrollback_cell(history, 0, 0, &first) || first.codepoint != 'f') return 29;
  if (!ofs_terminal_set_scrollback_limit(history, 1) || ofs_terminal_scrollback_lines(history) != 1) return 30;
  if (!ofs_terminal_get_scrollback_cell(history, 0, 0, &first) || first.codepoint != 't') return 31;
  if (!ofs_terminal_set_scrollback_limit(history, 0) || !ofs_terminal_resize(history, 2, 10)) return 32;
  ofs_terminal_clear(history);
  if (ofs_terminal_scrollback_lines(history) != 0 || ofs_terminal_cursor_row(history) != 0) return 33;
  ofs_terminal_destroy(history);
  ofs_terminal *snapshot = ofs_terminal_create(2, 8);
  if (!snapshot) return 54;
  const char *snapshot_text = "\x1b[31mA\xCC\x81\x1b[0m欢";
  if (ofs_terminal_feed(snapshot, snapshot_text, strlen(snapshot_text)) != strlen(snapshot_text)) return 55;
  ofs_terminal_snapshot_cell screen_cells[16] = {0};
  if (ofs_terminal_copy_screen(snapshot, screen_cells, 15) != 0) return 56;
  if (ofs_terminal_copy_screen(snapshot, screen_cells, 16) != 16) return 57;
  if (screen_cells[0].cell.codepoint != 'A' || screen_cells[0].codepoint_count != 2 ||
      screen_cells[0].codepoints[1] != 0x0301u || screen_cells[0].cell.fg_type != 1) return 58;
  const char *snapshot_lines = "\r\nline1\r\nline2\r\nline3";
  if (ofs_terminal_feed(snapshot, snapshot_lines, strlen(snapshot_lines)) != strlen(snapshot_lines)) return 59;
  if (ofs_terminal_scrollback_lines(snapshot) < 2) return 59;
  ofs_terminal_snapshot_cell scrollback_cells[16] = {0};
  if (ofs_terminal_copy_scrollback(snapshot, 0, 2, scrollback_cells, 10) != 0) return 60;
  if (ofs_terminal_copy_scrollback(snapshot, 0, 2, scrollback_cells, 16) != 16) return 61;
  ofs_terminal_cell expected_scrollback = {0};
  if (!ofs_terminal_get_scrollback_cell(snapshot, 0, 0, &expected_scrollback) ||
      scrollback_cells[0].cell.codepoint != expected_scrollback.codepoint ||
      scrollback_cells[0].cell.width != expected_scrollback.width) return 62;
  if (ofs_terminal_copy_scrollback(snapshot, ofs_terminal_scrollback_lines(snapshot), 1,
      scrollback_cells, 16) != 0) return 63;
  ofs_terminal_destroy(snapshot);
  printf("terminal probe passed; cursor=%d,%d; bytes=%zu\n", ofs_terminal_cursor_row(t), ofs_terminal_cursor_col(t), n);
  ofs_terminal_destroy(t); return 0;
}
