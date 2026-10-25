// Native integration regression through Yoga's public layout API.
// A 52pt measured text row after a 2020 1/3pt spacer previously became
// 51.999878pt on a 3x screen; iOS TextKit omitted the last line. JS component
// tests mock Yoga and cannot catch this precision loss. This executable uses
// the installed production Yoga sources; see ../README.md for the command.
#include <yoga/Yoga.h>
#include <cstdio>
#include <cmath>
#include <initializer_list>
static YGSize measure(YGNodeConstRef, float, YGMeasureMode, float, YGMeasureMode) { return {332, 52}; }
int main() {
 auto config=YGConfigNew(); YGConfigSetPointScaleFactor(config,3);
 int failures=0;
 for (float offset: {1000.333333f, 2020.333333f, 4070.333333f}) {
  auto root=YGNodeNewWithConfig(config); YGNodeStyleSetWidth(root,332);
  auto spacer=YGNodeNewWithConfig(config); YGNodeStyleSetHeight(spacer,offset);
  auto text=YGNodeNewWithConfig(config); YGNodeSetMeasureFunc(text,measure);
  YGNodeInsertChild(root,spacer,0); YGNodeInsertChild(root,text,1);
  YGNodeCalculateLayout(root,YGUndefined,YGUndefined,YGDirectionLTR);
  float height=YGNodeLayoutGetHeight(text);
  printf("offset=%.9f textHeight=%.9f expected=52\n",offset,height);
  if(std::abs(height-52)>0.00001) failures++;
  YGNodeFreeRecursive(root);
 }
 YGConfigFree(config); return failures ? 1 : 0;
}
