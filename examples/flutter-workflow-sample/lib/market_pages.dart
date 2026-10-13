part of 'workflow_lab.dart';

extension _MarketPages on _WorkflowLabState {
  Future<void> loadShops({bool append = false}) async {
    final result = await api(
      '/api/shop/shops?q=${Uri.encodeQueryComponent(value('shopSearch'))}&category=${Uri.encodeQueryComponent(category)}&page=$shopPage',
    );
    update(() {
      shops = append
          ? [...shops, ...result['shops'] as List]
          : result['shops'] as List;
      shopTotal = result['total'] as int;
    });
  }

  Future<void> openNativeAddress() async {
    final address = await storage.invokeMapMethod<String, dynamic>(
      'openAddress',
      {'base': base, 'run': run, 'session': session},
    );
    if (address == null) return;
    for (final key in ['recipient', 'phone', 'street']) {
      field(key).text = address[key] as String;
    }
    await persist();
    update(() => message = '原生地址已保存并带回结算页');
  }

  Widget productImage(String image, {double width = 90, double height = 90}) =>
      ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: Image.network(
          '$base$image',
          width: width,
          height: height,
          fit: BoxFit.cover,
          errorBuilder: (_, error, stack) => SizedBox(
            width: width,
            height: height,
            child: const Center(child: Text('图片加载失败')),
          ),
        ),
      );

  Widget pill(String label, {Color color = const Color(0xffffeee2)}) =>
      Container(
        margin: const EdgeInsets.only(right: 5, top: 4),
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(5),
        ),
        child: Text(label, style: const TextStyle(fontSize: 11)),
      );

  Future<void> showSku(Map<String, dynamic> product) async {
    selected = product;
    variantId = '';
    await showModalBottomSheet<void>(
      context: navigator.currentContext!,
      isScrollControlled: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (context, refresh) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    productImage(product['image']),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${product['name']}',
                            style: const TextStyle(
                              fontSize: 22,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          Text('商品 ${product['id']}'),
                          Text(
                            '月售 ${product['sold']} · 好评 ${product['rating']}',
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: '关闭规格',
                      onPressed: () => Navigator.pop(sheetContext),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                const Text('选择规格', style: TextStyle(fontSize: 18)),
                Wrap(
                  spacing: 8,
                  children: (product['variants'] as List)
                      .map(
                        (variant) => ChoiceChip(
                          label: Text(
                            '${variant['name']} ${money(variant['price'])}',
                          ),
                          selected: variantId == variant['id'],
                          onSelected: (_) => refresh(
                            () => variantId = variant['id'] as String,
                          ),
                        ),
                      )
                      .toList(),
                ),
                const SizedBox(height: 12),
                Text(product['description'] as String),
                const SizedBox(height: 10),
                const Text(
                  '库存与配送费以结算页为准。优惠可在活动页领取。',
                  style: TextStyle(fontSize: 12, color: Colors.grey),
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: variantId.isEmpty
                        ? null
                        : () async {
                            Navigator.pop(sheetContext);
                            await work(addToCart);
                          },
                    child: const Text('选好了，加入购物车'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> openStore(Map<String, dynamic> shop) async {
    selectedShop = shop;
    page = 0;
    category = '';
    field('search').clear();
    await loadCatalog();
    go('store');
  }

  Widget marketScreen(String name) {
    if (name == 'campaign') {
      return Scaffold(
        appBar: AppBar(
          title: const Text('活动会场'),
          leading: IconButton(
            tooltip: '返回商城',
            icon: const Icon(Icons.arrow_back),
            onPressed: () =>
                update(() => pages = pages.sublist(0, pages.length - 1)),
          ),
        ),
        body: AndroidView(
          viewType: 'workflow_lab/campaign',
          creationParams: {'base': base, 'run': run, 'session': session},
          creationParamsCodec: const StandardMessageCodec(),
        ),
      );
    }
    final store = name == 'store';
    return Scaffold(
      backgroundColor: const Color(0xfff4f5f1),
      appBar: AppBar(
        backgroundColor: const Color(0xffffd666),
        title: Text(
          store
              ? '${selectedShop!['name']} · ${selectedShop!['branch']}'
              : '城市生活',
        ),
        leading: store
            ? IconButton(
                tooltip: '返回附近门店',
                icon: const Icon(Icons.arrow_back),
                onPressed: () =>
                    update(() => pages = pages.sublist(0, pages.length - 1)),
              )
            : null,
        actions: [
          IconButton(
            tooltip: '活动领券',
            onPressed: () => go('campaign'),
            icon: const Icon(Icons.local_offer_outlined),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => work(store ? loadCatalog : loadShops),
        child: CustomScrollView(
          slivers: [
            if (busy)
              const SliverToBoxAdapter(child: LinearProgressIndicator()),
            if (message.isNotEmpty)
              SliverToBoxAdapter(
                child: Container(
                  padding: const EdgeInsets.all(12),
                  color: const Color(0xfffff3cf),
                  child: Text(message),
                ),
              ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (!store)
                      Row(
                        children: [
                          const Icon(Icons.location_on_outlined, size: 18),
                          const Expanded(child: Text('科技园 · 配送到家')),
                          TextButton(
                            onPressed: () => work(openNativeAddress),
                            child: const Text('切换地址'),
                          ),
                        ],
                      ),
                    Row(
                      children: [
                        Expanded(
                          child: input(
                            store ? 'search' : 'shopSearch',
                            store ? '搜索店内商品' : '搜索门店或商品',
                          ),
                        ),
                        TextButton(
                          onPressed: () => work(() async {
                            if (store) {
                              page = 0;
                              await loadCatalog();
                            } else {
                              shopPage = 0;
                              await loadShops();
                            }
                          }),
                          child: const Text('搜索'),
                        ),
                      ],
                    ),
                    if (!store) ...[
                      SizedBox(
                        height: 108,
                        child: GridView.count(
                          crossAxisCount: 5,
                          physics: const NeverScrollableScrollPhysics(),
                          childAspectRatio: 1.3,
                          children:
                              [
                                    '美食',
                                    '超市',
                                    '鲜花',
                                    '药店',
                                    '生鲜',
                                    '生活',
                                    '出行',
                                    '办公',
                                    '到店',
                                    '更多',
                                  ]
                                  .asMap()
                                  .entries
                                  .map(
                                    (entry) => InkWell(
                                      onTap: () => work(() async {
                                        category =
                                            [
                                              '生活',
                                              '出行',
                                              '办公',
                                            ].contains(entry.value)
                                            ? entry.value
                                            : '';
                                        shopPage = 0;
                                        await loadShops();
                                      }),
                                      child: Column(
                                        children: [
                                          CircleAvatar(
                                            radius: 14,
                                            backgroundColor: Colors
                                                .primaries[entry.key]
                                                .shade100,
                                            child: Icon(
                                              [
                                                Icons.restaurant,
                                                Icons.shopping_basket,
                                                Icons.local_florist,
                                                Icons.medication,
                                                Icons.eco,
                                              ][entry.key % 5],
                                              size: 17,
                                            ),
                                          ),
                                          Text(
                                            entry.value,
                                            style: const TextStyle(
                                              fontSize: 12,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  )
                                  .toList(),
                        ),
                      ),
                      SizedBox(
                        height: 116,
                        child: PageView(
                          children: [
                            for (var i = 0; i < 3; i++)
                              InkWell(
                                onTap: () => go('campaign'),
                                child: Container(
                                  margin: const EdgeInsets.symmetric(
                                    vertical: 9,
                                  ),
                                  padding: const EdgeInsets.all(14),
                                  decoration: BoxDecoration(
                                    color: [
                                      const Color(0xffdfeadc),
                                      const Color(0xffffddbf),
                                      const Color(0xffe0e9f0),
                                    ][i],
                                    borderRadius: BorderRadius.circular(18),
                                  ),
                                  child: Row(
                                    children: [
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              ['周末生活节', '品质好物精选', '新客专属福利'][i],
                                              style: const TextStyle(
                                                fontSize: 22,
                                                fontWeight: FontWeight.bold,
                                              ),
                                            ),
                                            const Text('店铺券 + 平台券，可叠加使用'),
                                            const Text(
                                              '进入活动会场 →',
                                              style: TextStyle(fontSize: 12),
                                            ),
                                          ],
                                        ),
                                      ),
                                      productImage(
                                        '/images/product-$i.png',
                                        width: 80,
                                        height: 70,
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      Row(
                        children: [
                          const Expanded(
                            child: Text(
                              '附近门店',
                              style: TextStyle(
                                fontSize: 21,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          Text('$shopTotal 家可配送'),
                        ],
                      ),
                    ] else ...[
                      Row(
                        children: [
                          productImage(
                            selectedShop!['image'],
                            width: 60,
                            height: 54,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              '评分 ${selectedShop!['rating']} · 月售 ${selectedShop!['sold']}\n${selectedShop!['minutes']}分钟 · ${selectedShop!['distance']}',
                            ),
                          ),
                        ],
                      ),
                      Wrap(
                        children: [
                          pill('满50减10'),
                          pill('30分钟配送'),
                          pill('售后保障'),
                        ],
                      ),
                      const SizedBox(height: 12),
                      const Text(
                        '店内商品',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Wrap(
                  spacing: 8,
                  children: ['全部', '生活', '出行', '办公']
                      .map(
                        (item) => FilterChip(
                          label: Text(item),
                          selected: category == (item == '全部' ? '' : item),
                          onSelected: (_) => work(() async {
                            category = item == '全部' ? '' : item;
                            if (store) {
                              page = 0;
                              await loadCatalog();
                            } else {
                              shopPage = 0;
                              await loadShops();
                            }
                          }),
                        ),
                      )
                      .toList(),
                ),
              ),
            ),
            if (store)
              SliverList.builder(
                itemCount: products.length,
                itemBuilder: (context, index) {
                  final product = Map<String, dynamic>.from(products[index]);
                  return Card(
                    margin: const EdgeInsets.fromLTRB(12, 5, 12, 5),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          productImage(product['image']),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${product['name']} · ${product['id']}',
                                  style: const TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 16,
                                  ),
                                ),
                                Text(
                                  '月售 ${product['sold']} · 评分 ${product['rating']}',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: Colors.grey,
                                  ),
                                ),
                                Wrap(
                                  children: [
                                    pill('品质优选'),
                                    pill(product['category']),
                                  ],
                                ),
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        money(product['variants'][0]['price']),
                                        style: const TextStyle(
                                          color: Colors.deepOrange,
                                          fontSize: 18,
                                        ),
                                      ),
                                    ),
                                    TextButton(
                                      onPressed: () => showSku(product),
                                      child: Text('选规格 ${product['id']}'),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              )
            else
              SliverList.builder(
                itemCount: shops.length,
                itemBuilder: (context, index) {
                  final shop = Map<String, dynamic>.from(shops[index]);
                  return Card(
                    margin: const EdgeInsets.fromLTRB(12, 5, 12, 5),
                    child: InkWell(
                      onTap: () => work(() => openStore(shop)),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            productImage(shop['image'], width: 82, height: 82),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    '${shop['name']} · ${shop['branch']}',
                                    style: const TextStyle(
                                      fontSize: 16,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                  Text(
                                    '⭐ ${shop['rating']}  月售 ${shop['sold']}   ${shop['minutes']}分钟',
                                    style: const TextStyle(fontSize: 12),
                                  ),
                                  Text(
                                    '门店 ${shop['id']} · ${shop['distance']} · 起送 ¥20',
                                    style: const TextStyle(
                                      fontSize: 12,
                                      color: Colors.grey,
                                    ),
                                  ),
                                  Wrap(
                                    children: (shop['tags'] as List)
                                        .map((tag) => pill(tag))
                                        .toList(),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    if (store) Text('共 $total 件，第 ${page + 1} 页'),
                    asyncButton(store ? '下一页商品' : '加载更多门店', () async {
                      if (store) {
                        page++;
                        await loadCatalog();
                      } else {
                        shopPage++;
                        await loadShops(append: true);
                      }
                    }),
                    TextButton(
                      onPressed: () => work(() async {
                        orders =
                            (await api('/api/shop/orders'))['orders'] as List;
                        go('orders');
                      }),
                      child: const Text('我的订单'),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: store
          ? SafeArea(
              child: Container(
                padding: const EdgeInsets.all(10),
                color: const Color(0xff223d35),
                child: Row(
                  children: [
                    const Icon(
                      Icons.shopping_bag_outlined,
                      color: Colors.white,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        '购物袋 · ${lines.fold<int>(0, (sum, line) => sum + line['quantity'] as int)} 件',
                        style: const TextStyle(color: Colors.white),
                      ),
                    ),
                    FilledButton(
                      onPressed: () => work(() async {
                        await loadCart();
                        go('cart');
                      }),
                      child: const Text('查看购物车'),
                    ),
                  ],
                ),
              ),
            )
          : NavigationBar(
              selectedIndex: 0,
              onDestinationSelected: (index) {
                if (index == 1) go('campaign');
                if (index == 2) {
                  work(() async {
                    orders = (await api('/api/shop/orders'))['orders'] as List;
                    go('orders');
                  });
                }
                if (index == 3) go('account');
              },
              destinations: const [
                NavigationDestination(
                  icon: Icon(Icons.home_outlined),
                  label: '首页',
                ),
                NavigationDestination(
                  icon: Icon(Icons.local_offer_outlined),
                  label: '活动',
                ),
                NavigationDestination(
                  icon: Icon(Icons.receipt_long_outlined),
                  label: '订单',
                ),
                NavigationDestination(
                  icon: Icon(Icons.person_outline),
                  label: '我的',
                ),
              ],
            ),
    );
  }
}
