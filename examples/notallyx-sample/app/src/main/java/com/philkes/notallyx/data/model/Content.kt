package com.philkes.notallyx.data.model

import androidx.lifecycle.LiveData
import androidx.lifecycle.MediatorLiveData
import androidx.lifecycle.asLiveData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow

/** Lifecycle-aware projection; inactive screens do not keep a Room observer alive. */
class Content(
    private var liveData: LiveData<List<BaseNote>>,
    private val transform: (List<BaseNote>) -> List<Item>,
) : MediatorLiveData<List<Item>>() {

    constructor(
        flow: Flow<List<BaseNote>>,
        transform: (List<BaseNote>) -> List<Item>,
        scope: CoroutineScope,
    ) : this(flow.asLiveData(scope.coroutineContext + Dispatchers.IO), transform)

    init {
        setObserver(liveData)
    }

    fun setObserver(liveData: LiveData<List<BaseNote>>) {
        removeSource(this.liveData)
        this.liveData = liveData
        addSource(liveData) { list -> value = transform(list) }
    }
}
