package io.github.balakrishnangithub.bever

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Android WebView does not consistently expose system-bar insets through
    // CSS env(). Inset the content natively; the shared CSS handles other shells.
    //
    // The on-screen keyboard is included: an edge-to-edge window is no longer
    // resized for it, so without this the keyboard would cover the note being
    // typed. With it, the page shrinks and the caret stays in view.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
      insets
    }
  }
}
