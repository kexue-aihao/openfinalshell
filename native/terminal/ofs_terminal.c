#include "ofs_terminal.h"
#include "vterm.h"
#include "vterm_internal.h"
#include "vterm_keycodes.h"
#include <stdlib.h>
#include <string.h>

struct ofs_terminal {
  VTerm *vt; VTermScreen *screen; int rows, cols; int alt_screen, mouse_mode;
  VTermScreenCallbacks callbacks;
  VTermScreenCell *scrollback;
  int scrollback_capacity, scrollback_count, scrollback_start;
  char *output; size_t output_length, output_capacity; int output_error;
};
#define MAX_OUTPUT_BYTES (16U * 1024U * 1024U)
#define MAX_PASTE_BYTES (4U * 1024U * 1024U)
static void cb_output(const char *bytes, size_t length, void *user) {
  ofs_terminal *t = (ofs_terminal *)user;
  if (!t || !bytes || length == 0 || t->output_error) return;
  if (length > MAX_OUTPUT_BYTES - t->output_length) { t->output_error = 1; return; }
  size_t required = t->output_length + length;
  if (required > t->output_capacity) {
    size_t next = t->output_capacity ? t->output_capacity : 4096;
    while (next < required) next = next > MAX_OUTPUT_BYTES / 2 ? MAX_OUTPUT_BYTES : next * 2;
    char *buffer = (char *)realloc(t->output, next);
    if (!buffer) { t->output_error = 1; return; }
    t->output = buffer; t->output_capacity = next;
  }
  memcpy(t->output + t->output_length, bytes, length);
  t->output_length += length;
}
static int cb_damage(VTermRect r, void *u) { (void)r; (void)u; return 0; }
static int cb_moverect(VTermRect a, VTermRect b, void *u) { (void)a; (void)b; (void)u; return 0; }
static int cb_movecursor(VTermPos a, VTermPos b, int c, void *u) { (void)a; (void)b; (void)c; (void)u; return 0; }
static int cb_setprop(VTermProp p, VTermValue *v, void *u) {
  ofs_terminal *t = (ofs_terminal *)u;
  if (p == VTERM_PROP_ALTSCREEN && v) t->alt_screen = v->boolean;
  if (p == VTERM_PROP_MOUSE && v) t->mouse_mode = v->number;
  return 1;
}
static int cb_bell(void *u) { (void)u; return 0; }
static int cb_resize(int r, int c, void *u) { (void)r; (void)c; (void)u; return 0; }
static int cb_scroll(int c, const VTermScreenCell *v, void *u) { (void)c; (void)v; (void)u; return 0; }
static int cb_pop(int c, VTermScreenCell *v, void *u) { (void)c; (void)v; (void)u; return 0; }
static int cb_clear(void *u) { (void)u; return 0; }
static int cb_pushline(int cols, const VTermScreenCell *cells, void *u) {
  ofs_terminal *t = (ofs_terminal *)u;
  if (!t || !cells || cols != t->cols || !t->scrollback) return 1;
  int index;
  if (t->scrollback_count < t->scrollback_capacity) {
    index = (t->scrollback_start + t->scrollback_count) % t->scrollback_capacity;
    t->scrollback_count++;
  } else {
    index = t->scrollback_start;
    t->scrollback_start = (t->scrollback_start + 1) % t->scrollback_capacity;
  }
  memcpy(t->scrollback + ((size_t)index * (size_t)t->cols), cells, sizeof(VTermScreenCell) * (size_t)t->cols);
  return 1;
}

ofs_terminal *ofs_terminal_create(int rows, int cols) {
  if (rows < 1 || cols < 1) return NULL;
  ofs_terminal *t = (ofs_terminal *)calloc(1, sizeof(*t));
  if (!t) return NULL;
  t->rows = rows; t->cols = cols; t->scrollback_capacity = 10000; t->scrollback = calloc((size_t)t->scrollback_capacity * (size_t)cols, sizeof(VTermScreenCell));
  t->vt = vterm_new(rows, cols);
  if (!t->vt || !t->scrollback) { if (t->vt) vterm_free(t->vt); free(t->scrollback); free(t); return NULL; }
  vterm_set_utf8(t->vt, 1); vterm_output_set_callback(t->vt, cb_output, t); t->screen = vterm_obtain_screen(t->vt);
  t->callbacks = (VTermScreenCallbacks){ cb_damage, cb_moverect, cb_movecursor, cb_setprop, cb_bell, cb_resize, cb_pushline, cb_pop, cb_clear };
  vterm_screen_set_callbacks(t->screen, &t->callbacks, t);
  vterm_screen_enable_altscreen(t->screen, 1);
  vterm_state_reset(vterm_obtain_state(t->vt), 1);
  vterm_screen_set_damage_merge(t->screen, VTERM_DAMAGE_SCROLL);
  return t;
}

void ofs_terminal_destroy(ofs_terminal *t) { if (!t) return; vterm_free(t->vt); free(t->scrollback); free(t->output); free(t); }
size_t ofs_terminal_feed(ofs_terminal *t, const char *bytes, size_t length) {
  return t && bytes ? vterm_input_write(t->vt, bytes, length) : 0;
}
int ofs_terminal_resize(ofs_terminal *t, int rows, int cols) {
  if (!t || rows < 1 || cols < 1) return 0;
  if (cols != t->cols) {
    if ((size_t)t->scrollback_capacity * (size_t)cols > (256U * 1024U * 1024U) / sizeof(VTermScreenCell)) return 0;
    VTermScreenCell *next = t->scrollback_capacity ? calloc((size_t)t->scrollback_capacity * (size_t)cols, sizeof(VTermScreenCell)) : NULL;
    if (t->scrollback_capacity && !next) return 0;
    for (int line = 0; line < t->scrollback_count; line++) {
      int index = (t->scrollback_start + line) % t->scrollback_capacity;
      memcpy(next + (size_t)line * (size_t)cols, t->scrollback + (size_t)index * (size_t)t->cols,
        sizeof(VTermScreenCell) * (size_t)(cols < t->cols ? cols : t->cols));
    }
    free(t->scrollback); t->scrollback = next; t->scrollback_start = 0;
  }
  vterm_set_size(t->vt, rows, cols); t->rows = rows; t->cols = cols; return 1;
}
int ofs_terminal_set_scrollback_limit(ofs_terminal *t, int lines) {
  if (!t || lines < 0 || lines > 100000) return 0;
  /* Bound allocations even for a very wide terminal. */
  if ((size_t)lines * (size_t)t->cols > (256U * 1024U * 1024U) / sizeof(VTermScreenCell)) return 0;
  VTermScreenCell *next = lines ? calloc((size_t)lines * (size_t)t->cols, sizeof(VTermScreenCell)) : NULL;
  if (lines && !next) return 0;
  int count = t->scrollback_count < lines ? t->scrollback_count : lines;
  for (int line = 0; line < count; line++) {
    int index = (t->scrollback_start + t->scrollback_count - count + line) % t->scrollback_capacity;
    memcpy(next + (size_t)line * (size_t)t->cols, t->scrollback + (size_t)index * (size_t)t->cols, sizeof(VTermScreenCell) * (size_t)t->cols);
  }
  free(t->scrollback); t->scrollback = next; t->scrollback_capacity = lines; t->scrollback_count = count; t->scrollback_start = 0;
  return 1;
}
void ofs_terminal_clear(ofs_terminal *t) {
  if (!t) return;
  t->scrollback_count = 0; t->scrollback_start = 0;
  vterm_screen_reset(t->screen, 1);
}
size_t ofs_terminal_read_text(ofs_terminal *t, char *buffer, size_t capacity) {
  if (!t || !buffer || capacity == 0) return 0;
  VTermRect rect = { 0, t->rows, 0, t->cols };
  return vterm_screen_get_text(t->screen, buffer, capacity, rect);
}
int ofs_terminal_cursor_row(ofs_terminal *t) { VTermPos p; if (!t) return -1; vterm_state_get_cursorpos(vterm_obtain_state(t->vt), &p); return p.row; }
int ofs_terminal_cursor_col(ofs_terminal *t) { VTermPos p; if (!t) return -1; vterm_state_get_cursorpos(vterm_obtain_state(t->vt), &p); return p.col; }
static void copy_color(const VTermColor *color, uint8_t *type, uint8_t *r, uint8_t *g, uint8_t *b, uint8_t *index) {
  *type = (uint8_t)color->type;
  if (color->type == VTERM_COLOR_RGB) { *r = color->rgb.red; *g = color->rgb.green; *b = color->rgb.blue; }
  else if (color->type == VTERM_COLOR_INDEXED) *index = color->indexed.idx;
}
int ofs_terminal_get_cell(ofs_terminal *t, int row, int col, ofs_terminal_cell *out) {
  if (!t || !out || row < 0 || row >= t->rows || col < 0 || col >= t->cols) return 0;
  VTermScreenCell cell; VTermPos pos = { row, col };
  if (!vterm_screen_get_cell(t->screen, pos, &cell)) return 0;
  *out = (ofs_terminal_cell){0}; out->codepoint = cell.chars[0]; out->width = (uint8_t)cell.width;
  out->attrs = (uint16_t)(cell.attrs.bold ? 1 : 0) | (uint16_t)(cell.attrs.underline ? 2 : 0) | (uint16_t)(cell.attrs.italic ? 4 : 0) | (uint16_t)(cell.attrs.reverse ? 8 : 0) | (uint16_t)(cell.attrs.strike ? 16 : 0);
  copy_color(&cell.fg, &out->fg_type, &out->fg_r, &out->fg_g, &out->fg_b, &out->fg_index);
  copy_color(&cell.bg, &out->bg_type, &out->bg_r, &out->bg_g, &out->bg_b, &out->bg_index);
  return 1;
}
static int copy_cell(const VTermScreenCell *cell, ofs_terminal_cell *out) {
  if (!cell || !out) return 0;
  *out = (ofs_terminal_cell){0}; out->codepoint = cell->chars[0]; out->width = (uint8_t)cell->width;
  out->attrs = (uint16_t)(cell->attrs.bold ? 1 : 0) | (uint16_t)(cell->attrs.underline ? 2 : 0) | (uint16_t)(cell->attrs.italic ? 4 : 0) | (uint16_t)(cell->attrs.reverse ? 8 : 0) | (uint16_t)(cell->attrs.strike ? 16 : 0);
  copy_color(&cell->fg, &out->fg_type, &out->fg_r, &out->fg_g, &out->fg_b, &out->fg_index);
  copy_color(&cell->bg, &out->bg_type, &out->bg_r, &out->bg_g, &out->bg_b, &out->bg_index);
  return 1;
}
static int copy_codepoints(const VTermScreenCell *cell, uint32_t *codepoints, int capacity) {
  if (!cell || !codepoints || capacity <= 0) return 0;
  int count = 0;
  for (int i = 0; i < VTERM_MAX_CHARS_PER_CELL && count < capacity; i++) {
    if (cell->chars[i] == 0) break;
    codepoints[count++] = cell->chars[i];
  }
  return count;
}
int ofs_terminal_get_cell_codepoints(ofs_terminal *t, int row, int col, uint32_t *codepoints, int capacity) {
  if (!t || row < 0 || row >= t->rows || col < 0 || col >= t->cols) return 0;
  VTermScreenCell cell; VTermPos pos = { row, col };
  return vterm_screen_get_cell(t->screen, pos, &cell) ? copy_codepoints(&cell, codepoints, capacity) : 0;
}
int ofs_terminal_scrollback_lines(ofs_terminal *t) { return t ? t->scrollback_count : 0; }
int ofs_terminal_get_scrollback_cell(ofs_terminal *t, int line, int col, ofs_terminal_cell *out) {
  if (!t || !out || line < 0 || line >= t->scrollback_count || col < 0 || col >= t->cols || !t->scrollback) return 0;
  int index = (t->scrollback_start + line) % t->scrollback_capacity;
  return copy_cell(&t->scrollback[(size_t)index * (size_t)t->cols + (size_t)col], out);
}
int ofs_terminal_get_scrollback_codepoints(ofs_terminal *t, int line, int col, uint32_t *codepoints, int capacity) {
  if (!t || line < 0 || line >= t->scrollback_count || col < 0 || col >= t->cols || !t->scrollback) return 0;
  int index = (t->scrollback_start + line) % t->scrollback_capacity;
  return copy_codepoints(&t->scrollback[(size_t)index * (size_t)t->cols + (size_t)col], codepoints, capacity);
}
static void copy_snapshot_cell(const VTermScreenCell *source, ofs_terminal_snapshot_cell *target) {
  if (!source || !target) return;
  memset(target, 0, sizeof(*target));
  target->valid = 1;
  copy_cell(source, &target->cell);
  target->codepoint_count = (uint8_t)copy_codepoints(source, target->codepoints,
    OFS_TERMINAL_MAX_CELL_CODEPOINTS);
}
int ofs_terminal_copy_screen(ofs_terminal *t, ofs_terminal_snapshot_cell *cells, size_t capacity) {
  if (!t || !cells) return 0;
  size_t count = (size_t)t->rows * (size_t)t->cols;
  if (capacity < count) return 0;
  for (int row = 0; row < t->rows; row++) {
    for (int col = 0; col < t->cols; col++) {
      VTermScreenCell cell;
      VTermPos pos = { row, col };
      ofs_terminal_snapshot_cell *target = cells + (size_t)row * (size_t)t->cols + (size_t)col;
      if (vterm_screen_get_cell(t->screen, pos, &cell)) copy_snapshot_cell(&cell, target);
      else memset(target, 0, sizeof(*target));
    }
  }
  return (int)count;
}
int ofs_terminal_copy_scrollback(ofs_terminal *t, int first_line, int line_count,
    ofs_terminal_snapshot_cell *cells, size_t capacity) {
  if (!t || !cells || first_line < 0 || line_count < 0 || first_line > t->scrollback_count ||
      line_count > t->scrollback_count - first_line || !t->scrollback) return 0;
  size_t count = (size_t)line_count * (size_t)t->cols;
  if (capacity < count) return 0;
  for (int line = 0; line < line_count; line++) {
    int index = (t->scrollback_start + first_line + line) % t->scrollback_capacity;
    for (int col = 0; col < t->cols; col++) {
      copy_snapshot_cell(&t->scrollback[(size_t)index * (size_t)t->cols + (size_t)col],
        cells + (size_t)line * (size_t)t->cols + (size_t)col);
    }
  }
  return (int)count;
}
int ofs_terminal_alt_screen(ofs_terminal *t) { return t ? t->alt_screen : 0; }
int ofs_terminal_mouse_mode(ofs_terminal *t) { return t ? t->mouse_mode : 0; }
int ofs_terminal_bracketed_paste(ofs_terminal *t) {
  return t ? (int)vterm_obtain_state(t->vt)->mode.bracketpaste : 0;
}

static VTermModifier modifiers(int value) {
  return (VTermModifier)(value & VTERM_ALL_MODS_MASK);
}

int ofs_terminal_key(ofs_terminal *t, int key, int mod) {
  if (!t || key < 0 || key >= VTERM_N_KEYS) return 0;
  vterm_keyboard_key(t->vt, (VTermKey)key, modifiers(mod));
  return 1;
}

int ofs_terminal_unichar(ofs_terminal *t, uint32_t codepoint, int mod) {
  if (!t || codepoint > 0x10ffffU || (codepoint >= 0xd800U && codepoint <= 0xdfffU)) return 0;
  vterm_keyboard_unichar(t->vt, codepoint, modifiers(mod));
  return 1;
}

static int decode_utf8(const unsigned char *bytes, size_t length, size_t *used, uint32_t *codepoint) {
  if (!bytes || !used || !codepoint || length == 0) return 0;
  unsigned char first = bytes[0];
  uint32_t value = 0; size_t count = 0;
  if (first < 0x80) { *used = 1; *codepoint = first; return 1; }
  if ((first & 0xe0) == 0xc0) { value = first & 0x1f; count = 2; }
  else if ((first & 0xf0) == 0xe0) { value = first & 0x0f; count = 3; }
  else if ((first & 0xf8) == 0xf0) { value = first & 0x07; count = 4; }
  else { *used = 1; *codepoint = 0xfffd; return 1; }
  if (length < count) return 0;
  for (size_t i = 1; i < count; i++) {
    if ((bytes[i] & 0xc0) != 0x80) { *used = 1; *codepoint = 0xfffd; return 1; }
    value = (value << 6) | (bytes[i] & 0x3f);
  }
  if ((count == 2 && value < 0x80) || (count == 3 && value < 0x800) ||
      (count == 4 && value < 0x10000) || value > 0x10ffff ||
      (value >= 0xd800 && value <= 0xdfff)) { *used = 1; *codepoint = 0xfffd; return 1; }
  *used = count; *codepoint = value; return 1;
}

int ofs_terminal_paste_utf8(ofs_terminal *t, const char *bytes, size_t length) {
  if (!t || (!bytes && length != 0) || length > MAX_PASTE_BYTES) return 0;
  vterm_keyboard_start_paste(t->vt);
  size_t offset = 0;
  while (offset < length) {
    size_t used = 0; uint32_t codepoint = 0;
    if (!decode_utf8((const unsigned char *)bytes + offset, length - offset, &used, &codepoint)) break;
    vterm_keyboard_unichar(t->vt, codepoint, VTERM_MOD_NONE); offset += used;
  }
  vterm_keyboard_end_paste(t->vt);
  return offset == length ? 1 : 0;
}

int ofs_terminal_mouse_move(ofs_terminal *t, int row, int col, int mod) {
  if (!t || row < 0 || col < 0) return 0;
  vterm_mouse_move(t->vt, row, col, modifiers(mod)); return 1;
}

int ofs_terminal_mouse_button(ofs_terminal *t, int button, int pressed, int mod) {
  if (!t || button < 1 || button > 8) return 0;
  vterm_mouse_button(t->vt, button, pressed != 0, modifiers(mod)); return 1;
}

size_t ofs_terminal_read_output(ofs_terminal *t, char *buffer, size_t capacity) {
  if (!t || !buffer || capacity == 0) return 0;
  size_t count = t->output_length < capacity ? t->output_length : capacity;
  if (count == 0) return 0;
  memcpy(buffer, t->output, count);
  t->output_length -= count;
  if (t->output_length > 0) memmove(t->output, t->output + count, t->output_length);
  return count;
}
int ofs_terminal_take_output_error(ofs_terminal *t) { if (!t) return 1; int error = t->output_error; t->output_error = 0; return error; }
