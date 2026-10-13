import 'dart:convert';
import 'dart:io';
import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'recovery_fixture.dart';

part 'lab_pages.dart';
part 'market_pages.dart';

const storage = MethodChannel('workflow_lab/config');

class ApiFailure implements Exception {
  final int status;
  final Map<String, dynamic> data;
  ApiFailure(this.status, this.data);
  @override
  String toString() => '${data['error']} (HTTP $status)';
}

class WorkflowLab extends StatefulWidget {
  const WorkflowLab({super.key});
  @override
  State<WorkflowLab> createState() => _WorkflowLabState();
}

class _WorkflowLabState extends State<WorkflowLab> {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 3);
  final navigator = GlobalKey<NavigatorState>();
  final fields = <String, TextEditingController>{};
  String base = '',
      run = '',
      session = '',
      message = '',
      resumePage = 'catalog';
  List<String> pages = ['setup'];
  bool busy = false, agreement = false, reviewAgreement = false;
  int generation = 0, page = 0, total = 0, cartRevision = 0;
  String category = '',
      variantId = '',
      checkoutKey = '',
      paymentKey = '',
      refundKey = '';
  List<dynamic> products = [], lines = [], orders = [];
  Map<String, dynamic>? selected, quote, order, inspection;
  bool cityMode = false;
  List<dynamic> shops = [];
  int shopPage = 0, shopTotal = 0;
  Map<String, dynamic>? selectedShop;
  String deliverySlot = '尽快送达';
  FlutterRecoveryFixture? recoveryFixture;

  void update(VoidCallback action) => setState(action);

  TextEditingController field(String key) =>
      fields.putIfAbsent(key, TextEditingController.new);
  String value(String key) => field(key).text;
  String money(dynamic cents) =>
      '¥${((cents as num) / 100).toStringAsFixed(2)}';
  String key(String prefix) =>
      '$prefix-$run-${DateTime.now().microsecondsSinceEpoch}';

  @override
  void initState() {
    super.initState();
    storage.setMethodCallHandler((call) async {
      if (call.method == 'uriChanged') {
        await configure(call.arguments as String?);
      } else if (call.method == 'campaignClosed') {
        if (pages.last == 'campaign') {
          setState(() {
            pages = pages.sublist(0, pages.length - 1);
            message = '活动已结束，可在结算页使用已领取的优惠';
          });
        }
      }
    });
    storage.invokeMethod<String>('initialUri').then(configure);
  }

  @override
  void dispose() {
    generation++;
    client.close(force: true);
    for (final controller in fields.values) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> configure(String? raw) async {
    if (raw == null) {
      setState(() => message = '请从测试工作台打开，并传入 HTTP 服务地址与运行编号。');
      return;
    }
    final uri = Uri.parse(raw), parameters = Uri.parse(raw).queryParameters;
    generation++;
    if (uri.host == 'recovery') {
      final runId = parameters['run']!, point = parameters['point']!;
      if (!RegExp(r'^[a-zA-Z0-9-]{1,80}$').hasMatch(runId) ||
          !['before-effect', 'after-effect'].contains(point)) {
        throw ArgumentError('Recovery requires a unique run and fault point');
      }
      final directory = await storage.invokeMethod<String>('filesDirectory');
      setState(() {
        recoveryFixture = FlutterRecoveryFixture(
          key: ValueKey(runId),
          directory: directory!,
          runId: runId,
          faultPoint: point,
        );
        pages = ['recovery'];
      });
      return;
    }
    base = parameters['base'] ?? '';
    run = parameters['run'] ?? '';
    if (base.isEmpty || run.isEmpty) {
      setState(() => message = '缺少 base 或 run');
      return;
    }
    final saved = await storage.invokeMethod<String>('read', {'run': run});
    final state = saved == null
        ? <String, dynamic>{}
        : jsonDecode(saved) as Map<String, dynamic>;
    session = state['session'] as String? ?? '';
    checkoutKey = state['checkoutKey'] as String? ?? '';
    paymentKey = state['paymentKey'] as String? ?? '';
    refundKey = state['refundKey'] as String? ?? '';
    order = state['order'] as Map<String, dynamic>?;
    for (final controller in fields.values) {
      controller.clear();
    }
    for (final entry
        in (state['fields'] as Map<String, dynamic>? ?? {}).entries) {
      field(entry.key).text = entry.value as String;
    }
    message = '';
    products = [];
    lines = [];
    orders = [];
    selected = null;
    quote = null;
    busy = false;
    agreement = false;
    reviewAgreement = false;
    category = '';
    page = 0;
    cityMode = uri.host == 'city';
    shops = [];
    shopPage = 0;
    selectedShop = null;
    if (uri.host == 'review') {
      session = parameters['session'] ?? '';
      if (session.isEmpty) {
        throw StateError('Native handoff requires its current session');
      }
      resumePage = 'inspection';
      field('inspectionId').text = parameters['order'] ?? '';
      setState(() => pages = ['inspection']);
      await work(loadInspection);
    } else {
      resumePage = cityMode ? 'market' : 'catalog';
      setState(() => pages = [session.isEmpty ? 'login' : resumePage]);
      if (session.isNotEmpty) await work(cityMode ? loadShops : loadCatalog);
    }
  }

  Future<void> persist() => storage.invokeMethod('write', {
    'run': run,
    'value': jsonEncode({
      'session': session,
      'checkoutKey': checkoutKey,
      'paymentKey': paymentKey,
      'refundKey': refundKey,
      'order': order,
      'fields': {
        for (final entry in fields.entries.where(
          (entry) => entry.key != 'password',
        ))
          entry.key: entry.value.text,
      },
    }),
  });

  Future<Map<String, dynamic>> api(
    String route, [
    Map<String, dynamic>? body,
  ]) async {
    final requestedGeneration = generation;
    final uri = Uri.parse('$base$route');
    final target = uri.replace(
      queryParameters: {...uri.queryParameters, 'run': run},
    );
    final request = await client.openUrl(body == null ? 'GET' : 'POST', target);
    request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $session');
    request.headers.set('x-lab-source', 'flutter');
    if (body != null) {
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode(body));
    }
    final response = await request.close().timeout(const Duration(seconds: 4));
    final result =
        jsonDecode(await response.transform(utf8.decoder).join())
            as Map<String, dynamic>;
    if (requestedGeneration != generation) {
      throw StateError('Run changed while a request was in flight');
    }
    if (response.statusCode >= 400) {
      throw ApiFailure(response.statusCode, result);
    }
    return result;
  }

  Future<void> work(Future<void> Function() operation) async {
    if (busy) return;
    final startedGeneration = generation;
    setState(() {
      busy = true;
      message = '';
    });
    try {
      await operation();
    } on ApiFailure catch (error) {
      if (generation != startedGeneration) return;
      if (error.status == 401) {
        resumePage = pages.last;
        session = '';
        await persist();
        if (mounted) {
          setState(() {
            pages = ['login'];
            message = '登录已失效，重新登录后继续，草稿已保留';
          });
        }
      } else if (mounted) {
        setState(() => message = error.toString());
      }
    } catch (error) {
      if (generation != startedGeneration) return;
      if (mounted) {
        setState(() => message = '连接中断或响应超时：$error。已提交的订单或支付请先查询结果。');
      }
    } finally {
      if (mounted && generation == startedGeneration) {
        setState(() => busy = false);
      }
    }
  }

  void go(String page, {bool root = false}) => setState(() {
    message = '';
    pages = root ? [page] : [...pages, page];
  });

  Future<void> login() async {
    final result = await api('/api/session', {
      'account': value('account'),
      'password': value('password'),
      'agreement': agreement,
    });
    session = result['session'] as String;
    await persist();
    go(resumePage, root: true);
    if (resumePage == 'catalog') {
      await loadCatalog();
    }
    if (resumePage == 'market') await loadShops();
    if (resumePage == 'checkout') {
      await loadCart();
    }
    if (resumePage == 'inspection') {
      await loadInspection();
    }
  }

  Future<void> loadCatalog() async {
    final result = await api(
      '/api/shop/catalog?q=${Uri.encodeQueryComponent(value('search'))}&category=${Uri.encodeQueryComponent(category)}&page=$page',
    );
    setState(() {
      products = result['products'] as List;
      total = result['total'] as int;
    });
  }

  Future<void> loadCart() async {
    final result = await api('/api/shop/cart');
    setState(() {
      lines = result['lines'] as List;
      cartRevision = result['revision'] as int;
    });
  }

  Future<void> changeQuantity(Map<String, dynamic> line, int quantity) async {
    final result = await api('/api/shop/cart', {
      'productId': line['productId'],
      'variantId': line['variantId'],
      'quantity': quantity,
      'revision': cartRevision,
    });
    setState(() {
      lines = result['lines'] as List;
      cartRevision = result['revision'] as int;
    });
  }

  Future<void> addToCart() async {
    if (variantId.isEmpty) {
      setState(() => message = '请先选择规格');
      return;
    }
    await loadCart();
    final existing = lines
        .where((line) => line['variantId'] == variantId)
        .firstOrNull;
    await changeQuantity({
      'productId': selected!['id'],
      'variantId': variantId,
    }, (existing?['quantity'] as int? ?? 0) + 1);
    setState(() => message = '已加入购物车');
  }

  Future<void> calculate() async {
    await persist();
    final result = await api('/api/shop/quote', {
      'cartRevision': cartRevision,
      'address': {
        'recipient': value('recipient'),
        'phone': value('phone'),
        'street': value('street'),
      },
      'coupon': value('coupon'),
      if (cityMode) 'platformCoupon': value('platformCoupon'),
      if (cityMode) 'deliverySlot': deliverySlot,
    });
    setState(() => quote = result['quote'] as Map<String, dynamic>);
  }

  Future<void> submitOrder() async {
    if (quote == null) {
      setState(() => message = '请先核算金额');
      return;
    }
    checkoutKey = checkoutKey.isEmpty ? key('checkout') : checkoutKey;
    await persist();
    final result = await api('/api/shop/orders', {
      'quoteId': quote!['id'],
      'idempotencyKey': checkoutKey,
    });
    order = result['order'] as Map<String, dynamic>;
    await persist();
    go('order');
  }

  Future<void> refreshOrder() async {
    if (order == null) {
      final result = await api('/api/shop/orders');
      final matches = (result['orders'] as List).where(
        (item) => item['idempotencyKey'] == checkoutKey,
      );
      if (matches.isEmpty) {
        setState(() => message = '该订单尚未提交，可继续原结算');
        return;
      }
      order = matches.single as Map<String, dynamic>;
    } else {
      order =
          (await api('/api/shop/orders/${order!['id']}'))['order']
              as Map<String, dynamic>;
    }
    await persist();
    setState(() {});
  }

  Future<void> pay() async {
    paymentKey = paymentKey.isEmpty ? key('payment') : paymentKey;
    await persist();
    order =
        (await api('/api/shop/orders/${order!['id']}/pay', {
              'idempotencyKey': paymentKey,
            }))['order']
            as Map<String, dynamic>;
    await persist();
    setState(() {});
  }

  Future<void> refund() async {
    refundKey = refundKey.isEmpty ? key('refund') : refundKey;
    await persist();
    order =
        (await api('/api/shop/orders/${order!['id']}/refund', {
              'idempotencyKey': refundKey,
              'reason': value('refund'),
            }))['order']
            as Map<String, dynamic>;
    await persist();
    go('order', root: true);
  }

  Future<void> loadInspection() async {
    final result = await api('/api/orders/${value('inspectionId')}');
    setState(() => inspection = result['order'] as Map<String, dynamic>);
  }

  Future<void> confirm(
    String title,
    String detail,
    Future<void> Function() action,
  ) async {
    final accepted = await showDialog<bool>(
      context: navigator.currentContext!,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(detail),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('返回修改'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('确认操作'),
          ),
        ],
      ),
    );
    if (accepted == true) {
      await work(action);
    }
  }

  Widget input(String key, String label, {bool password = false}) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: TextField(
      controller: field(key),
      obscureText: password,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      onChanged: (_) {
        if (!password) {
          persist();
        }
      },
    ),
  );
  Widget button(String label, VoidCallback action) => Padding(
    padding: const EdgeInsets.all(3),
    child: FilledButton(onPressed: busy ? null : action, child: Text(label)),
  );
  Widget asyncButton(String label, Future<void> Function() action) =>
      button(label, () => work(action));
  Widget text(String label) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Text(label),
  );

  Widget screen(String name) => name == 'recovery'
      ? recoveryFixture!
      : ['market', 'store', 'campaign'].contains(name)
      ? marketScreen(name)
      : Scaffold(
          appBar: AppBar(
            title: Text('业务实验室 · $name'),
            leading: pages.length > 1
                ? IconButton(
                    tooltip: '返回上一页',
                    icon: const Icon(Icons.arrow_back),
                    onPressed: () => setState(() {
                      pages = pages.sublist(0, pages.length - 1);
                      message = '';
                    }),
                  )
                : null,
          ),
          body: SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (busy) const LinearProgressIndicator(),
                  if (message.isNotEmpty)
                    Text(
                      message,
                      style: const TextStyle(color: Colors.deepOrange),
                    ),
                  ...content(name),
                ],
              ),
            ),
          ),
        );

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Bridge Workflow Lab',
    theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
    home: Navigator(
      key: navigator,
      observers: [AiAppBridge.instance.navigatorObserver],
      pages: [
        for (var index = 0; index < pages.length; index++)
          MaterialPage(
            key: ValueKey('$index-${pages[index]}'),
            name: pages[index],
            child: screen(pages[index]),
          ),
      ],
      onDidRemovePage: (page) {
        if (pages.length > 1 &&
            page.key == ValueKey('${pages.length - 1}-${pages.last}')) {
          setState(() => pages = pages.sublist(0, pages.length - 1));
        }
      },
    ),
  );
}
