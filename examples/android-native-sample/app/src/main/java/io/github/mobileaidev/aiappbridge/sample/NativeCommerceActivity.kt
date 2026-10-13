package io.github.mobileaidev.aiappbridge.sample

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Pure Android Views counterpart of the city workflow, using the same HTTP ledger. */
class NativeCommerceActivity : Activity() {
    private val client = OkHttpClient.Builder().callTimeout(4, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()
    private val readClient = client.newBuilder().retryOnConnectionFailure(true).build()
    private val io = Executors.newFixedThreadPool(4)
    private val pictures = android.util.LruCache<String, Bitmap>(12)
    private val prefs by lazy { getSharedPreferences("native-commerce", MODE_PRIVATE) }
    private lateinit var base: String
    private lateinit var run: String
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private var generation = 0
    private var session = ""
    private var category = ""
    private var query = ""
    private var page = 0
    private var cartRevision = 0
    private var lines = JSONArray()
    private var order: JSONObject? = null
    private var quote: JSONObject? = null
    private var checkoutKey = ""
    private var paymentKey = ""
    private var refundKey = ""
    private var web: WebView? = null
    private var reopenAfterLogin: (() -> Unit)? = null
    private val draft = mutableMapOf<String, String>()

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        base = intent.getStringExtra("lab_base_url").orEmpty()
        run = intent.getStringExtra("lab_run").orEmpty()
        if (base.isEmpty() || run.isEmpty()) { screen("原生城市生活"); label("请传入 lab_base_url 和 lab_run"); return }
        session = prefs.getString("$run:session", "").orEmpty()
        for (key in listOf("recipient", "phone", "street", "coupon", "platformCoupon")) draft[key] = prefs.getString("$run:$key", "").orEmpty()
        checkoutKey = prefs.getString("$run:checkoutKey", "").orEmpty()
        paymentKey = prefs.getString("$run:paymentKey", "").orEmpty()
        refundKey = prefs.getString("$run:refundKey", "").orEmpty()
        order = prefs.getString("$run:order", null)?.let(::JSONObject)
        if (session.isEmpty()) login() else home()
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); recreate() }
    override fun onDestroy() { generation++; web?.destroy(); io.shutdownNow(); super.onDestroy() }
    private fun keep(key: String, value: String) { prefs.edit().putString("$run:$key", value).apply() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun money(value: Int) = "¥%.2f".format(java.util.Locale.ROOT, value / 100.0)
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8")
    private fun screen(title: String, scroll: Boolean = true, reopen: (() -> Unit)? = null) {
        generation++; web?.destroy(); web = null
        reopenAfterLogin = reopen
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(245, 246, 241)) }
        if (android.os.Build.VERSION.SDK_INT >= 30) root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
            view.setPadding(0, bars.top, 0, bars.bottom); insets
        }
        root.addView(TextView(this).apply { text = title; textSize = 23f; setPadding(dp(16), dp(20), dp(16), dp(18)); setBackgroundColor(Color.rgb(255, 213, 102)) })
        status = TextView(this).apply { textSize = 14f; contentDescription = "city_status"; setPadding(dp(12), dp(5), dp(12), dp(5)) }; root.addView(status)
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, dp(12), dp(12)) }
        if (scroll) root.addView(ScrollView(this).apply { addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f))
        else root.addView(body, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }
    private fun label(value: String, size: Float = 16f, parent: LinearLayout = body) = TextView(this).also {
        it.text = value; it.textSize = size; it.setPadding(0, dp(5), 0, dp(5)); parent.addView(it)
    }
    private fun button(title: String, key: String, parent: LinearLayout = body, action: () -> Unit) = Button(this).also {
        it.text = title; it.contentDescription = key; it.setOnClickListener { action() }; parent.addView(it)
    }
    private fun field(title: String, key: String, value: String = "") = EditText(this).also {
        it.hint = title; it.contentDescription = key; it.setText(value); it.setSingleLine(true); body.addView(it)
    }
    private fun api(route: String, data: JSONObject? = null, done: (JSONObject) -> Unit) {
        val observedGeneration = generation
        status.text = "正在加载…"
        io.execute {
            try {
                val request = Request.Builder().url("$base$route${if (route.contains('?')) '&' else '?'}run=${encode(run)}")
                    .header("Authorization", "Bearer $session").header("x-lab-source", "native-city")
                if (data != null) request.post(data.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
                (if (data == null) readClient else client).newCall(request.build()).execute().use { response ->
                    val result = JSONObject(response.body!!.string())
                    runOnUiThread {
                        if (isFinishing || isDestroyed || observedGeneration != generation) return@runOnUiThread
                        if (response.isSuccessful) { status.text = ""; done(result) }
                        else if (response.code == 401 && route != "/api/session") {
                            val reopen = reopenAfterLogin
                            session = ""; keep("session", ""); quote = null
                            login(reopen)
                            status.text = "登录已失效，请重新登录；结算草稿和服务端记录已保留"
                        }
                        else { status.text = "请求失败 ${response.code}：${result.optString("error")}，可修正后重试" }
                    }
                }
            } catch (error: Exception) {
                android.util.Log.w("NativeCityLab", "${if (data == null) "GET" else "POST"} $route failed", error)
                runOnUiThread {
                if (!isFinishing && !isDestroyed && observedGeneration == generation) status.text = "结果未确认：${error.javaClass.simpleName}。订单和支付请先查询结果。"
            } }
        }
    }
    private fun image(url: String, side: Int = 82): ImageView = ImageView(this).apply {
        layoutParams = LinearLayout.LayoutParams(dp(side), dp(side)); scaleType = ImageView.ScaleType.CENTER_CROP; tag = url
        val cached = pictures.get(url)
        if (cached != null) setImageBitmap(cached)
        else io.execute {
            try { readClient.newCall(Request.Builder().url("$base$url").build()).execute().use { response ->
                val bitmap = BitmapFactory.decodeStream(response.body!!.byteStream()) ?: return@use
                pictures.put(url, bitmap); runOnUiThread { if (!isDestroyed && tag == url) setImageBitmap(bitmap) }
            } } catch (_: java.io.IOException) { runOnUiThread { if (!isDestroyed && tag == url) contentDescription = "图片加载失败" } }
        }
    }
    private fun confirm(title: String, description: String, done: () -> Unit) {
        AlertDialog.Builder(this).setTitle(title).setMessage(description).setNegativeButton("返回修改", null).setPositiveButton("确认操作") { _, _ -> done() }.show()
    }
    private fun login(reopen: (() -> Unit)? = null) {
        screen("原生账号登录")
        label("欢迎使用城市生活", 25f)
        val account = field("登录账号", "city_account")
        val password = field("登录密码", "city_password").apply { inputType = 129 }
        label("请阅读并同意用户协议。说明中的同意与按钮不是同一个控件。")
        val consent = CheckBox(this).apply { text = "同意用户协议"; contentDescription = "city_agreement" }; body.addView(consent)
        button("登录并继续", "city_login") {
            api("/api/session", JSONObject().put("account", account.text.toString()).put("password", password.text.toString()).put("agreement", consent.isChecked)) {
                session = it.getString("session"); keep("session", session)
                if (reopen == null) home() else reopen()
            }
        }
    }
    private fun home() {
        screen("原生城市生活", false, ::home)
        val search = field("搜索门店或商品", "city_search", query)
        val tools = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }; body.addView(tools)
        button("搜索", "city_search_submit", tools) { query = search.text.toString(); page = 0; home() }
        button("活动领券", "city_campaign", tools) { campaign() }
        button("我的订单", "city_orders", tools) { history() }
        val categories = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        for (name in listOf("全部", "生活", "出行", "办公")) button(name, "city_category_$name", categories) { category = if (name == "全部") "" else name; page = 0; home() }
        body.addView(HorizontalScrollView(this).apply { addView(categories) })
        label("附近门店 · 即时配送 · 满50减10", 18f)
        val list = ListView(this).apply { dividerHeight = dp(8) }; body.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        button("下一页门店", "city_next_shops") { page++; home() }
        api("/api/shop/shops?q=${encode(query)}&category=${encode(category)}&page=$page") { result ->
            status.text = "门店 ${result.getInt("total")} 家 · 第 ${page + 1} 页"
            val shops = result.getJSONArray("shops")
            list.adapter = object : BaseAdapter() {
                override fun getCount() = shops.length()
                override fun getItem(position: Int) = shops.getJSONObject(position)
                override fun getItemId(position: Int) = position.toLong()
                override fun getView(position: Int, reused: View?, parent: ViewGroup): View {
                    val shop = getItem(position)
                    val row = (reused as? LinearLayout ?: LinearLayout(this@NativeCommerceActivity)).apply {
                        removeAllViews(); orientation = LinearLayout.HORIZONTAL; setPadding(dp(8), dp(10), dp(8), dp(10)); setBackgroundColor(Color.WHITE)
                        contentDescription = "city_shop_${shop.getString("id")}"; setOnClickListener { page = 0; query = ""; category = ""; store(shop) }
                    }
                    row.addView(image(shop.getString("image")))
                    val info = LinearLayout(this@NativeCommerceActivity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0) }; row.addView(info, LinearLayout.LayoutParams(0, -2, 1f))
                    label("${shop.getString("name")} · ${shop.getString("branch")}", 18f, info)
                    label("评分 ${shop.getString("rating")} · 月售 ${shop.getInt("sold")}", 12f, info)
                    label("${shop.getString("id")} · ${shop.getInt("minutes")}分钟 · ${shop.getString("distance")}", 12f, info)
                    label("满50减10  新客福利  支持退款", 12f, info)
                    return row
                }
            }
        }
    }
    private fun store(shop: JSONObject) {
        screen("${shop.getString("name")} · ${shop.getString("branch")}", false) { store(shop) }
        label("评分 ${shop.getString("rating")} · 30分钟达 · ${shop.getString("distance")}")
        val search = field("搜索店内商品", "city_product_search", query)
        button("搜索商品", "city_product_search_submit") { query = search.text.toString(); page = 0; store(shop) }
        val list = ListView(this); body.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        button("下一页商品", "city_next_products") { page++; store(shop) }
        button("查看购物车", "city_cart") { cart() }
        api("/api/shop/catalog?q=${encode(query)}&page=$page") { result ->
            status.text = "店内商品 ${result.getInt("total")} 件 · 第 ${page + 1} 页"
            val products = result.getJSONArray("products")
            list.adapter = object : BaseAdapter() {
                override fun getCount() = products.length()
                override fun getItem(position: Int) = products.getJSONObject(position)
                override fun getItemId(position: Int) = position.toLong()
                override fun getView(position: Int, reused: View?, parent: ViewGroup): View {
                    val item = getItem(position)
                    val row = (reused as? LinearLayout ?: LinearLayout(this@NativeCommerceActivity)).apply { removeAllViews(); orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(8), 0, dp(8)) }
                    row.addView(image(item.getString("image")))
                    val info = LinearLayout(this@NativeCommerceActivity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(10), 0, 0, 0) }; row.addView(info, LinearLayout.LayoutParams(0, -2, 1f))
                    label("${item.getString("name")} · ${item.getString("id")}", 17f, info)
                    label("月售 ${item.getInt("sold")} · ${money(item.getJSONArray("variants").getJSONObject(0).getInt("price"))}", 12f, info)
                    button("选规格", "city_sku_${item.getString("id")}", info) { sku(item) }
                    return row
                }
            }
        }
    }
    private fun sku(product: JSONObject) {
        val choices = product.getJSONArray("variants")
        var selected = -1
        val dialog = AlertDialog.Builder(this).setTitle("${product.getString("name")} · 选择规格")
            .setSingleChoiceItems(Array(choices.length()) { index -> choices.getJSONObject(index).let { "${it.getString("name")} ${money(it.getInt("price"))}" } }, -1) { _, index -> selected = index }
            .setNegativeButton("取消", null).setPositiveButton("加入购物车", null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            if (selected < 0) { Toast.makeText(this, "请先选择规格", Toast.LENGTH_SHORT).show(); return@setOnClickListener }
            dialog.dismiss()
            api("/api/shop/cart") { cart ->
                val variant = choices.getJSONObject(selected)
                val current = cart.getJSONArray("lines")
                val quantity = (0 until current.length()).map { current.getJSONObject(it) }
                    .firstOrNull { it.getString("variantId") == variant.getString("id") }?.getInt("quantity") ?: 0
                api("/api/shop/cart", JSONObject().put("productId", product.getString("id")).put("variantId", variant.getString("id")).put("quantity", quantity + 1).put("revision", cart.getInt("revision"))) {
                    status.text = "已加入购物车"; Toast.makeText(this, "已加入购物车", Toast.LENGTH_SHORT).show()
                }
            }
        } }
        dialog.window?.setGravity(Gravity.BOTTOM); dialog.show()
    }
    private fun cart() {
        screen("原生购物车", reopen = ::cart)
        api("/api/shop/cart") { result ->
            lines = result.getJSONArray("lines"); cartRevision = result.getInt("revision")
            status.text = "购物车 ${lines.length()} 项"
            for (index in 0 until lines.length()) {
                val line = lines.getJSONObject(index)
                label("${line.getString("name")} · ${line.getString("variantName")}", 18f)
                label("${line.getString("variantId")} 数量 ${line.getInt("quantity")} · ${money(line.getInt("subtotal"))}")
                val tools = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }; body.addView(tools)
                fun change(quantity: Int) { api("/api/shop/cart", JSONObject().put("productId", line.getString("productId")).put("variantId", line.getString("variantId")).put("quantity", quantity).put("revision", cartRevision)) { cart() } }
                button("减一", "city_minus_${line.getString("variantId")}", tools) { change((line.getInt("quantity") - 1).coerceAtLeast(0)) }
                button("加一", "city_plus_${line.getString("variantId")}", tools) { change(line.getInt("quantity") + 1) }
                button("删除", "city_delete_${line.getString("variantId")}", tools) { confirm("删除商品", "确认移除当前规格？") { change(0) } }
            }
            button("填写地址并结算", "city_checkout") { checkout() }
            button("返回商城", "city_home") { home() }
        }
    }
    private fun checkout() {
        screen("原生订单结算", reopen = ::checkout)
        val editors = linkedMapOf<String, EditText>()
        for ((key, title) in listOf("recipient" to "收件人", "phone" to "联系电话", "street" to "详细地址", "coupon" to "店铺优惠码", "platformCoupon" to "平台优惠码")) editors[key] = field(title, "city_$key", draft[key].orEmpty())
        fun retain() { editors.forEach { (key, editor) -> draft[key] = editor.text.toString(); keep(key, editor.text.toString()) } }
        button("活动领券", "city_campaign") { retain(); campaign { checkout() } }
        button("保存草稿并重建页面", "city_recreate") { retain(); recreate() }
        button("核算金额", "city_quote") {
            retain()
            api("/api/shop/quote", JSONObject().put("cartRevision", cartRevision).put("address", JSONObject().apply { for (key in listOf("recipient", "phone", "street")) put(key, draft[key]) }).put("coupon", draft["coupon"]).put("platformCoupon", draft["platformCoupon"])) {
                quote = it.getJSONObject("quote")
                status.text = "应付 ${money(quote!!.getInt("payable"))}"
                label("商品 ${money(quote!!.getInt("subtotal"))} · 店铺优惠 ${money(quote!!.getInt("discount"))} · 平台优惠 ${money(quote!!.getInt("platformDiscount"))} · 运费 ${money(quote!!.getInt("shipping"))}")
            }
        }
        button("提交订单", "city_submit") {
            if (quote == null) { status.text = "请先核算金额"; return@button }
            confirm("确认提交", "应付 ${money(quote!!.getInt("payable"))}，提交后保留原单号") {
                if (checkoutKey.isEmpty()) checkoutKey = UUID.randomUUID().toString(); keep("checkoutKey", checkoutKey)
                api("/api/shop/orders", JSONObject().put("quoteId", quote!!.getString("id")).put("idempotencyKey", checkoutKey)) { acceptOrder(it); receipt() }
            }
        }
        button("查询提交结果", "city_query") { queryOrder() }
    }
    private fun acceptOrder(result: JSONObject) { order = result.getJSONObject("order"); keep("order", order.toString()) }
    private fun queryOrder() {
        if (order != null) api("/api/shop/orders/${order!!.getString("id")}") { acceptOrder(it); receipt() }
        else api("/api/shop/orders") { result ->
            val orders = result.getJSONArray("orders")
            for (index in 0 until orders.length()) if (orders.getJSONObject(index).getString("idempotencyKey") == checkoutKey) { order = orders.getJSONObject(index); keep("order", order.toString()); receipt(); return@api }
            status.text = "服务端尚未提交，可继续原结算"
        }
    }
    private fun receipt() {
        screen("订单 ${order!!.getString("id")}", reopen = ::receipt)
        val state = order!!.getString("status")
        label("订单状态：${mapOf("awaiting_payment" to "待支付", "paid" to "已支付", "refunded" to "已退款", "cancelled" to "已取消")[state]}", 22f)
        label("金额 ${money(order!!.getInt("payable"))}")
        button("查询订单结果", "city_query") { queryOrder() }
        if (state == "awaiting_payment") button("支付测试订单", "city_pay") { confirm("确认支付", "本地测试账本 ${money(order!!.getInt("payable"))}") {
            if (paymentKey.isEmpty()) paymentKey = UUID.randomUUID().toString(); keep("paymentKey", paymentKey)
            api("/api/shop/orders/${order!!.getString("id")}/pay", JSONObject().put("idempotencyKey", paymentKey)) { acceptOrder(it); receipt() }
        } }
        if (state == "paid") button("申请退款", "city_refund") {
            screen("退款申请")
            val reason = field("退款原因", "city_refund_reason")
            button("提交退款", "city_refund_submit") { confirm("确认退款", "退回原支付金额，并释放库存") {
                if (refundKey.isEmpty()) refundKey = UUID.randomUUID().toString(); keep("refundKey", refundKey)
                api("/api/shop/orders/${order!!.getString("id")}/refund", JSONObject().put("idempotencyKey", refundKey).put("reason", reason.text.toString())) { acceptOrder(it); receipt() }
            } }
        }
        button("返回商城", "city_home") { home() }
    }
    private fun history() {
        screen("原生订单列表", reopen = ::history)
        api("/api/shop/orders") { result -> val orders = result.getJSONArray("orders"); for (index in 0 until orders.length()) {
            val item = orders.getJSONObject(index); button("${item.getString("id")} · ${item.getString("status")} · ${money(item.getInt("payable"))}", "city_order_${item.getString("id")}") { order = item; receipt() }
        } }
    }
    private fun campaign(back: () -> Unit = { home() }) {
        screen("原生活动会场", false)
        button("返回商城", "city_campaign_back") { back() }
        web = WebView(this).apply {
            settings.javaScriptEnabled = true; webViewClient = WebViewClient(); contentDescription = "city_campaign_webview"
            addJavascriptInterface(object { @JavascriptInterface fun close() { runOnUiThread { back() } } }, "CityLab")
            body.addView(this, LinearLayout.LayoutParams(-1, 0, 1f))
            loadUrl("$base/campaign.html?run=${encode(run)}&session=${encode(session)}")
        }
    }
}
