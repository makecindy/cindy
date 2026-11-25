/* Map an X cursor-theme name onto the viewer's standard shape keywords.
 * Toolkits name cursors either with CSS names (GTK, Chromium) or legacy X
 * cursor-font names (Qt, Xt, window managers). Unknown and unnamed cursors
 * return NULL so the viewer keeps its local arrow. */
#include <stddef.h>
#include <string.h>

static const char *cursor_shape_for_name(const char *name) {
  static const struct {
    const char *shape;
    const char *names[12];
  } table[] = {
      {"default", {"default", "left_ptr", "arrow", "top_left_arrow",
                   "left_arrow", "right_ptr", "draft_large", "draft_small"}},
      {"text", {"text", "xterm", "ibeam"}},
      {"vertical-text", {"vertical-text"}},
      {"pointer", {"pointer", "hand", "hand1", "hand2", "pointing_hand"}},
      {"crosshair",
       {"crosshair", "cross", "tcross", "cross_reverse", "diamond_cross",
        "cell", "plus", "target", "dotbox"}},
      {"grab", {"grab", "openhand", "hand_open"}},
      {"grabbing", {"grabbing", "closedhand", "hand_closed", "dnd-none"}},
      {"move", {"move", "fleur", "all-scroll", "size_all", "dnd-move"}},
      {"ew-resize",
       {"ew-resize", "col-resize", "e-resize", "w-resize", "sb_h_double_arrow",
        "h_double_arrow", "size_hor", "split_h", "right_side", "left_side"}},
      {"ns-resize",
       {"ns-resize", "row-resize", "n-resize", "s-resize", "sb_v_double_arrow",
        "v_double_arrow", "size_ver", "split_v", "top_side", "bottom_side"}},
      {"nwse-resize",
       {"nwse-resize", "nw-resize", "se-resize", "size_fdiag",
        "bd_double_arrow", "top_left_corner", "bottom_right_corner"}},
      {"nesw-resize",
       {"nesw-resize", "ne-resize", "sw-resize", "size_bdiag",
        "fd_double_arrow", "top_right_corner", "bottom_left_corner"}},
      {"not-allowed",
       {"not-allowed", "no-drop", "dnd-no-drop", "forbidden", "crossed_circle",
        "circle", "pirate", "X_cursor"}},
      {"copy", {"copy", "dnd-copy"}},
      {"alias", {"alias", "dnd-link", "link"}},
      {"wait", {"wait", "watch"}},
      {"progress", {"progress", "left_ptr_watch", "half-busy"}},
      {"help", {"help", "question_arrow", "whats_this", "left_ptr_help",
                "dnd-ask"}},
  };
  if (!name || !*name)
    return NULL;
  for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++)
    for (size_t j = 0; j < 12 && table[i].names[j]; j++)
      if (!strcmp(name, table[i].names[j]))
        return table[i].shape;
  return NULL;
}
