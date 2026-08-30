package io.github.mobileaidev.aiappbridge.sample.intentfixture

import android.animation.ObjectAnimator
import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.github.mobileaidev.aiappbridge.android.AiAppBridge
import io.github.mobileaidev.aiappbridge.sample.R
import org.json.JSONObject
import java.util.UUID

/**
 * Deterministic, debug-only login fixture used to compare intent executors.
 *
 * The UI is intentionally more awkward than a demo form: it can begin on
 * several screens, duplicate the submit label, animate while work is pending,
 * show a blocking dialog, and produce distinct terminal outcomes. The hidden
 * `intent_fixture/oracle` state is reserved for the experiment scorer; an
 * executor under test must decide from visible UI and ordinary evidence.
 */
class IntentLoginFixtureActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val runtimeInstance = UUID.randomUUID().toString()
    private lateinit var screenHost: FrameLayout
    private lateinit var scenarioView: TextView
    private var screen = Screen.WELCOME
    private var authenticated = false
    private var submitCount = 0
    private var agreementToggleCount = 0
    private var pendingAnimator: ObjectAnimator? = null

    private val startScreen: Screen by lazy {
        when (intent.getStringExtra(EXTRA_START)?.lowercase()) {
            "login" -> Screen.LOGIN
            "home", "authenticated" -> Screen.HOME
            else -> Screen.WELCOME
        }
    }
    private val outcome: Outcome by lazy {
        when (intent.getStringExtra(EXTRA_OUTCOME)?.lowercase()) {
            "invalid", "credentials" -> Outcome.INVALID_CREDENTIALS
            "network", "offline" -> Outcome.NETWORK_ERROR
            "timeout" -> Outcome.TIMEOUT
            "otp", "challenge" -> Outcome.OTP_REQUIRED
            else -> Outcome.SUCCESS
        }
    }
    private val responseDelayMs: Long by lazy {
        stringExtraLong(EXTRA_DELAY_MS, 650L).coerceIn(0L, 30_000L)
    }
    private val duplicateSubmit: Boolean by lazy {
        stringExtraBoolean(EXTRA_DUPLICATE_SUBMIT)
    }
    private val animatePending: Boolean by lazy {
        stringExtraBoolean(EXTRA_ANIMATE)
    }
    private val blockingDialog: Boolean by lazy {
        stringExtraBoolean(EXTRA_DIALOG)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildFixtureRoot())
        when (startScreen) {
            Screen.WELCOME -> showWelcome()
            Screen.LOGIN -> showLogin()
            Screen.HOME -> showHome(alreadyAuthenticated = true)
            Screen.OTP -> showOtpChallenge()
        }
    }

    override fun onDestroy() {
        pendingAnimator?.cancel()
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun buildFixtureRoot(): View {
        val root = LinearLayout(this).apply {
            id = R.id.intent_fixture_root
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(20))
            contentDescription = "intent_fixture_root"
        }
        root.addView(TextView(this).apply {
            id = R.id.intent_fixture_title
            text = "Intent Login Fixture"
            textSize = 24f
            setTextColor(Color.BLACK)
            contentDescription = "intent_fixture_title"
        })
        scenarioView = TextView(this).apply {
            id = R.id.intent_fixture_scenario
            textSize = 12f
            setTextColor(Color.DKGRAY)
            setPadding(0, dp(6), 0, dp(14))
            contentDescription = "intent_fixture_scenario"
        }
        root.addView(scenarioView)
        screenHost = FrameLayout(this).apply {
            id = R.id.intent_fixture_screen_host
            contentDescription = "intent_fixture_screen_host"
        }
        root.addView(
            screenHost,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        return ScrollView(this).apply { addView(root) }
    }

    private fun showWelcome() {
        pendingAnimator?.cancel()
        screen = Screen.WELCOME
        authenticated = false
        scenarioView.text = scenarioSummary()
        val column = newScreenColumn("Welcome")
        column.addView(TextView(this).apply {
            text = "You are signed out. Open the login form to continue."
            textSize = 17f
            contentDescription = "signed_out_message"
        })
        column.addView(button("Login", R.id.intent_fixture_login_entry, "login_entry") {
            recordEvent("login_entry_activated")
            showLogin()
        })
        setScreen(column)
        recordOracle("welcome")
    }

    private fun showLogin() {
        pendingAnimator?.cancel()
        screen = Screen.LOGIN
        authenticated = false
        scenarioView.text = scenarioSummary()
        val column = newScreenColumn("Sign in")
        val account = EditText(this).apply {
            id = R.id.intent_fixture_account
            hint = "Email or account"
            contentDescription = "login_account"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            setSingleLine(true)
            setText(intent.getStringExtra(EXTRA_ACCOUNT_PREFILL).orEmpty())
        }
        val password = EditText(this).apply {
            id = R.id.intent_fixture_password
            hint = "Password"
            contentDescription = "login_password"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(true)
            setText(intent.getStringExtra(EXTRA_PASSWORD_PREFILL).orEmpty())
        }
        val terms = CheckBox(this).apply {
            id = R.id.intent_fixture_terms
            text = "Accept Terms"
            contentDescription = "login_terms"
            isChecked = stringExtraBoolean(EXTRA_TERMS_CHECKED)
            setOnCheckedChangeListener { _, checked ->
                agreementToggleCount += 1
                recordEvent("terms_changed", JSONObject().put("checked", checked))
                recordOracle("terms_changed")
            }
        }
        val status = TextView(this).apply {
            id = R.id.intent_fixture_status
            text = "Ready"
            textSize = 16f
            setTextColor(Color.DKGRAY)
            setPadding(0, dp(8), 0, dp(8))
            contentDescription = "login_status_ready"
        }
        val submit = button("Sign in", R.id.intent_fixture_submit, "login_submit") {
            submitLogin(account, password, terms, status)
        }
        column.addView(account)
        column.addView(password)
        column.addView(terms)
        column.addView(status)
        column.addView(submit)
        if (duplicateSubmit) {
            column.addView(button(
                "Sign in",
                R.id.intent_fixture_duplicate_submit,
                "sign_in_help_not_submit",
            ) {
                status.text = "Help opened; login was not submitted"
                status.contentDescription = "login_help_opened"
                recordEvent("duplicate_label_help_activated")
                recordOracle("duplicate_label_help")
            })
        }
        setScreen(column)
        recordOracle("login")
        if (blockingDialog) {
            handler.postDelayed({ showBlockingDialog() }, 180L)
        }
    }

    private fun submitLogin(
        account: EditText,
        password: EditText,
        terms: CheckBox,
        status: TextView,
    ) {
        submitCount += 1
        val accountText = account.text.toString()
        val passwordLength = password.text?.length ?: 0
        recordEvent(
            "submit_attempt",
            JSONObject()
                .put("submitCount", submitCount)
                .put("accountLength", accountText.length)
                .put("passwordLength", passwordLength)
                .put("termsChecked", terms.isChecked),
        )
        if (!terms.isChecked) {
            showStatus(status, "Please accept the terms", "login_error_terms_required", true)
            recordOracle("agreement_required")
            return
        }
        if (accountText.isBlank() || passwordLength == 0) {
            showStatus(status, "Account and password are required", "login_error_fields_required", true)
            recordOracle("fields_required")
            return
        }

        showStatus(status, "Signing in…", "login_submitting", false)
        recordOracle("submitting")
        if (animatePending) {
            pendingAnimator = ObjectAnimator.ofFloat(status, View.TRANSLATION_X, 0f, dp(10).toFloat(), 0f).apply {
                duration = 240L
                repeatCount = ObjectAnimator.INFINITE
                interpolator = LinearInterpolator()
                start()
            }
        }
        val delay = if (outcome == Outcome.TIMEOUT) maxOf(responseDelayMs, 8_000L) else responseDelayMs
        handler.postDelayed({
            pendingAnimator?.cancel()
            pendingAnimator = null
            when (outcome) {
                Outcome.SUCCESS -> {
                    recordNetwork(statusCode = 200, error = null)
                    showHome(alreadyAuthenticated = false)
                }
                Outcome.INVALID_CREDENTIALS -> {
                    recordNetwork(statusCode = 401, error = null)
                    showStatus(status, "Account or password is incorrect", "login_error_invalid_credentials", true)
                    recordOracle("invalid_credentials")
                }
                Outcome.NETWORK_ERROR -> {
                    recordNetwork(statusCode = 0, error = "offline")
                    showStatus(status, "Network unavailable", "login_error_network", true)
                    recordOracle("network_error")
                }
                Outcome.TIMEOUT -> {
                    recordNetwork(statusCode = 0, error = "timeout")
                    showStatus(status, "Request timed out", "login_error_timeout", true)
                    recordOracle("timeout")
                }
                Outcome.OTP_REQUIRED -> {
                    recordNetwork(statusCode = 202, error = null)
                    showOtpChallenge()
                }
            }
        }, delay)
    }

    private fun showOtpChallenge() {
        pendingAnimator?.cancel()
        screen = Screen.OTP
        authenticated = false
        val column = newScreenColumn("Verification required")
        column.addView(TextView(this).apply {
            text = "Enter the one-time code sent to the user"
            contentDescription = "otp_challenge_message"
        })
        val otp = EditText(this).apply {
            id = R.id.intent_fixture_otp
            hint = "One-time code"
            contentDescription = "otp_code"
            inputType = InputType.TYPE_CLASS_NUMBER
            setSingleLine(true)
        }
        column.addView(otp)
        column.addView(button("Verify", R.id.intent_fixture_otp_submit, "otp_submit") {
            recordEvent("otp_submit_attempt", JSONObject().put("length", otp.text?.length ?: 0))
        })
        setScreen(column)
        recordOracle("otp_required")
    }

    private fun showHome(alreadyAuthenticated: Boolean) {
        pendingAnimator?.cancel()
        screen = Screen.HOME
        authenticated = true
        val column = newScreenColumn("Home")
        column.addView(TextView(this).apply {
            id = R.id.intent_fixture_home
            text = if (alreadyAuthenticated) "Already authenticated" else "Login successful"
            textSize = 20f
            contentDescription = "authenticated_home"
        })
        setScreen(column)
        recordEvent(if (alreadyAuthenticated) "already_authenticated" else "login_succeeded")
        recordOracle(if (alreadyAuthenticated) "already_authenticated" else "authenticated")
    }

    private fun showBlockingDialog() {
        if (isFinishing || screen != Screen.LOGIN) return
        recordEvent("blocking_dialog_opened")
        AlertDialog.Builder(this)
            .setTitle("Before signing in")
            .setMessage("This fixture dialog intentionally blocks the login form.")
            .setPositiveButton("Continue") { _, _ ->
                recordEvent("blocking_dialog_closed")
                recordOracle("dialog_closed")
            }
            .setCancelable(false)
            .show()
    }

    private fun newScreenColumn(title: String): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        contentDescription = "intent_fixture_${title.lowercase().replace(' ', '_')}"
        addView(TextView(this@IntentLoginFixtureActivity).apply {
            text = title
            textSize = 21f
            setTextColor(Color.BLACK)
            setPadding(0, dp(8), 0, dp(14))
            contentDescription = "screen_${title.lowercase().replace(' ', '_')}"
        })
    }

    private fun setScreen(view: View) {
        screenHost.removeAllViews()
        screenHost.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
    }

    private fun button(label: String, id: Int, description: String, action: () -> Unit): Button =
        Button(this).apply {
            this.id = id
            text = label
            contentDescription = description
            isAllCaps = false
            setOnClickListener { action() }
        }

    private fun showStatus(status: TextView, message: String, description: String, error: Boolean) {
        status.text = message
        status.contentDescription = description
        status.setTextColor(if (error) Color.rgb(180, 20, 20) else Color.DKGRAY)
    }

    private fun recordNetwork(statusCode: Int, error: String?) {
        AiAppBridge.recordNetwork(
            method = "POST",
            url = "https://fixture.local/auth/login",
            statusCode = statusCode,
            durationMs = responseDelayMs,
            requestBody = JSONObject()
                .put("fixture", true)
                .put("outcome", outcome.name.lowercase())
                .toString(),
            responseBody = JSONObject()
                .put("authenticated", statusCode == 200)
                .put("challenge", statusCode == 202)
                .toString(),
            error = error,
        )
    }

    private fun recordEvent(name: String, extra: JSONObject = JSONObject()) {
        AiAppBridge.recordEvent(
            category = "intent_fixture",
            name = name,
            dataJson = extra
                .put("screen", screen.name.lowercase())
                .put("runtimeInstance", runtimeInstance)
                .toString(),
        )
    }

    private fun recordOracle(reason: String) {
        val oracle = JSONObject()
            .put("fixtureOracle", true)
            .put("runtimeInstance", runtimeInstance)
            .put("screen", screen.name.lowercase())
            .put("authenticated", authenticated)
            .put("outcome", outcome.name.lowercase())
            .put("submitCount", submitCount)
            .put("agreementToggleCount", agreementToggleCount)
            .put("reason", reason)
        AiAppBridge.recordState(
            namespace = "intent_fixture",
            key = "oracle",
            valueJson = oracle.toString(),
        )
    }

    private fun scenarioSummary(): String = buildString {
        append("start=")
        append(startScreen.name.lowercase())
        append(" outcome=")
        append(outcome.name.lowercase())
        if (duplicateSubmit) append(" duplicate-label")
        if (animatePending) append(" animated")
        if (blockingDialog) append(" dialog")
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun stringExtraBoolean(name: String): Boolean =
        intent.getStringExtra(name)?.equals("true", ignoreCase = true) == true

    private fun stringExtraLong(name: String, fallback: Long): Long =
        intent.getStringExtra(name)?.toLongOrNull() ?: fallback

    private enum class Screen { WELCOME, LOGIN, OTP, HOME }
    private enum class Outcome { SUCCESS, INVALID_CREDENTIALS, NETWORK_ERROR, TIMEOUT, OTP_REQUIRED }

    companion object {
        const val EXTRA_START = "start"
        const val EXTRA_OUTCOME = "outcome"
        const val EXTRA_DELAY_MS = "delay_ms"
        const val EXTRA_DUPLICATE_SUBMIT = "duplicate_submit"
        const val EXTRA_ANIMATE = "animate"
        const val EXTRA_DIALOG = "dialog"
        const val EXTRA_ACCOUNT_PREFILL = "account_prefill"
        const val EXTRA_PASSWORD_PREFILL = "password_prefill"
        const val EXTRA_TERMS_CHECKED = "terms_checked"
    }
}
