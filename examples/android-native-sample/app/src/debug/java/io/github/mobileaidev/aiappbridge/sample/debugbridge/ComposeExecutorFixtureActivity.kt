package io.github.mobileaidev.aiappbridge.sample.debugbridge

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.Button
import androidx.compose.material.MaterialTheme
import androidx.compose.material.OutlinedTextField
import androidx.compose.material.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

class ComposeExecutorFixtureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                var counter by remember { mutableStateOf(0) }
                var name by remember { mutableStateOf("") }
                Column(Modifier.padding(32.dp)) {
                    Text("Compose executor fixture")
                    Text("Counter: $counter", Modifier.testTag("counter"))
                    Button(onClick = { counter++ }, modifier = Modifier.testTag("increment")) { Text("Increment") }
                    OutlinedTextField(value = name, onValueChange = { name = it }, modifier = Modifier.testTag("name"), label = { Text("商品名称") })
                    Text("Selected: $name", Modifier.testTag("selected"))
                }
            }
        }
    }
}
