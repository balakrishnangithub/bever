package io.github.balakrishnangithub.bever

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class SyncServiceArgs {
  var message: String = "Synchronizing…"
  var current: Long = 0
  var total: Long = 0
}

@InvokeArg
class FileInfoArgs {
  var uri: String = ""
}

@InvokeArg
class OpenFileArgs {
  var path: String = ""
  var mime: String = "*/*"
}

/**
 * Native-only bridge for what only Android can do: keeping a sync alive in a
 * foreground service, describing files the user picked, and handing a file to
 * another application. It is intentionally not exposed as a frontend plugin.
 */
@TauriPlugin
class SyncPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private val lock = Object()
    private val handler = Handler(Looper.getMainLooper())
    private var pendingStart: Invoke? = null
    private var timeout: Runnable? = null

    fun acknowledgeStart() {
      val invoke = synchronized(lock) {
        timeout?.let(handler::removeCallbacks)
        timeout = null
        pendingStart.also { pendingStart = null }
      }
      invoke?.resolve()
    }

    fun failStart(message: String) {
      val invoke = synchronized(lock) {
        timeout?.let(handler::removeCallbacks)
        timeout = null
        pendingStart.also { pendingStart = null }
      }
      invoke?.reject(message)
    }
  }

  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(SyncServiceArgs::class.java)
    synchronized(lock) {
      if (pendingStart != null) {
        invoke.reject("A sync service is already starting")
        return
      }
      pendingStart = invoke
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      // Only an explicit Sync now action reaches this prompt. Denial does not
      // stop synchronization; notification visibility is controlled by Android.
      activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 4102)
    }
    val timeout = Runnable { failStart("Android did not acknowledge the sync service") }
    synchronized(lock) { SyncPlugin.timeout = timeout }
    handler.postDelayed(timeout, 10_000)
    try {
      val intent = Intent(activity, BeverSyncService::class.java).apply {
        action = BeverSyncService.ACTION_START
        putExtra(BeverSyncService.EXTRA_MESSAGE, args.message)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.startForegroundService(intent)
      } else {
        activity.startService(intent)
      }
    } catch (error: Exception) {
      failStart(error.message ?: "Cannot start Android sync service")
    }
  }

  @Command
  fun progress(invoke: Invoke) {
    val args = invoke.parseArgs(SyncServiceArgs::class.java)
    BeverSyncService.updateNotification(
      activity, args.message, args.current, args.total,
    )
    invoke.resolve()
  }

  @Command
  fun finish(invoke: Invoke) {
    val args = invoke.parseArgs(SyncServiceArgs::class.java)
    BeverSyncService.complete(activity, args.message)
    invoke.resolve()
  }

  /**
   * Display name, size, and media type of a picked `content://` document.
   * The picker identifies documents by opaque URIs, so their names have to
   * be asked for. Missing values are simply left out.
   */
  @Command
  fun fileInfo(invoke: Invoke) {
    val args = invoke.parseArgs(FileInfoArgs::class.java)
    val result = JSObject()
    result.put("name", "")
    try {
      val uri = Uri.parse(args.uri)
      val resolver = activity.contentResolver
      resolver.getType(uri)?.let { result.put("mime", it) }
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
        ?.use { cursor ->
          if (cursor.moveToFirst()) {
            val name = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val size = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (name >= 0 && !cursor.isNull(name)) result.put("name", cursor.getString(name))
            if (size >= 0 && !cursor.isNull(size)) result.put("size", cursor.getLong(size))
          }
        }
    } catch (_: Exception) {
      // The provider would not say; the caller falls back to the URI itself.
    }
    invoke.resolve(result)
  }

  /**
   * Opens a file from this application's cache in whichever application the
   * user chooses. Other applications cannot read the cache directly, so the
   * file is shared through the FileProvider with a one-time read grant.
   */
  @Command
  fun openFile(invoke: Invoke) {
    val args = invoke.parseArgs(OpenFileArgs::class.java)
    try {
      val file = File(args.path)
      val cache = activity.cacheDir.canonicalFile
      if (!file.canonicalFile.startsWith(cache)) {
        invoke.reject("Only files in the application cache can be opened")
        return
      }
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
      val view = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, args.mime.ifBlank { "*/*" })
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(Intent.createChooser(view, file.name))
      invoke.resolve()
    } catch (_: ActivityNotFoundException) {
      invoke.reject("No installed application can open this file")
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Cannot open the file")
    }
  }
}
