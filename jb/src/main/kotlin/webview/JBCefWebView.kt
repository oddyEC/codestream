package com.codestream.webview

import com.codestream.DEBUG
import com.google.gson.JsonElement
import com.intellij.openapi.diagnostic.Logger
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefContextMenuParams
import org.cef.callback.CefMenuModel
import org.cef.handler.CefContextMenuHandlerAdapter
import org.cef.handler.CefLoadHandlerAdapter

class JBCefWebView(val jbCefBrowser: JBCefBrowser, val router: WebViewRouter) : WebView {

    private val logger = Logger.getInstance(JBCefWebView::class.java)

    val routerQuery: JBCefJSQuery = JBCefJSQuery.create(jbCefBrowser).also {
        it.addHandler { message: String ->
            router.handle(message, null)
            null
        }

    }
    override val component = JBCefWebViewPanel(jbCefBrowser)

    init {
        logger.info("Initializing JBCef WebView")
        jbCefBrowser.jbCefClient.addContextMenuHandler(object : CefContextMenuHandlerAdapter(){
            override fun onBeforeContextMenu(
                browser: CefBrowser?,
                frame: CefFrame?,
                params: CefContextMenuParams?,
                model: CefMenuModel?
            ) {
                if (!DEBUG) {
                    model?.clear()
                }
            }
        }, jbCefBrowser.cefBrowser)
        jbCefBrowser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadingStateChange(
                browser: CefBrowser?,
                isLoading: Boolean,
                canGoBack: Boolean,
                canGoForward: Boolean
            ) {
                if (isLoading || jbCefBrowser.cefBrowser.url == "about:blank") return

                browser?.executeJavaScript(
                    """
                        console.log("Connecting router");
                        window.acquireHostApi = function() {
                            return {
                                postMessage: function(message, origin) {
                                    ${routerQuery.inject("JSON.stringify(message)")}
                                }
                            }
                        }
                        window.api = acquireHostApi();
                        if (window.messageQueue) {
                            console.log("Flushing " + messageQueue.length + " queued message(s)");
                            for (const message of messageQueue) {
                                api.postMessage(message)
                            }
                            window.messageQueue = [];
                        }
                        console.log("Router connected");
                    """.trimIndent(), browser.url, 0
                )
                logger.info("Router connected")
            }
        }, jbCefBrowser.cefBrowser)
    }

    override fun loadUrl(url: String) {
        jbCefBrowser.loadURL(url)
    }

    override fun dispose() {
        jbCefBrowser.dispose()
    }

    override fun postMessage(message: JsonElement) {
        jbCefBrowser.cefBrowser.executeJavaScript("window.postMessage($message,'*');", jbCefBrowser.cefBrowser.url, 0)
    }

    override fun focus() {
        component.grabFocus()
    }
}