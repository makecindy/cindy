package expo.modules.cindyselectionmenu

import android.text.style.LeadingMarginSpan
import com.facebook.react.views.text.internal.span.TextEffectSpan

/** Paragraph layout inside the existing selectable TextView; adds no text. */
class ListIndentSpan(first: Int, rest: Int) : LeadingMarginSpan.Standard(first, rest), TextEffectSpan
