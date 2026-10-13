part of 'workflow_lab.dart';

extension _LabPages on _WorkflowLabState {
  List<Widget> content(String screen) {
    switch (screen) {
      case 'setup':
        return [text('需要运行配置'), text('由测试工作台传入 base/run；这里不内置假数据。')];
      case 'login':
        return [
          text('账号登录'),
          input('account', '登录账号'),
          input('password', '登录密码', password: true),
          text('服务协议说明包含“同意”一词，请阅读后选择下方复选框。'),
          CheckboxListTile(
            title: const Text('同意用户协议'),
            value: agreement,
            onChanged: (value) => update(() => agreement = value!),
          ),
          asyncButton('登录并继续', login),
        ];
      case 'catalog':
        return [
          text('商品目录'),
          input('search', '搜索商品'),
          Wrap(
            children: ['全部', '生活', '出行', '办公']
                .map(
                  (item) => button(
                    item,
                    () => work(() async {
                      category = item == '全部' ? '' : item;
                      page = 0;
                      await loadCatalog();
                    }),
                  ),
                )
                .toList(),
          ),
          asyncButton('搜索', () async {
            page = 0;
            await loadCatalog();
          }),
          text('共 $total 件，第 ${page + 1} 页'),
          ...products.map(
            (item) => Card(
              child: ListTile(
                title: Text('${item['name']} · ${item['id']}'),
                subtitle: Text(
                  '${item['category']} · ${money(item['variants'][0]['price'])} 起',
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: () {
                  selected = Map<String, dynamic>.from(item);
                  variantId = '';
                  go('product');
                },
              ),
            ),
          ),
          if ((page + 1) * 6 < total)
            asyncButton('下一页', () async {
              page++;
              await loadCatalog();
            }),
          if (page > 0)
            asyncButton('上一页', () async {
              page--;
              await loadCatalog();
            }),
          asyncButton('购物车', () async {
            await loadCart();
            go('cart');
          }),
          asyncButton('我的订单', () async {
            orders = (await api('/api/shop/orders'))['orders'] as List;
            go('orders');
          }),
          button('账户与草稿', () => go('account')),
        ];
      case 'product':
        return [
          text('${selected!['name']} · ${selected!['id']}'),
          text(selected!['description'] as String),
          RadioGroup<String>(
            groupValue: variantId,
            onChanged: (value) => update(() => variantId = value!),
            child: Column(
              children: (selected!['variants'] as List)
                  .map(
                    (item) => RadioListTile<String>(
                      title: Text('${item['name']} ${money(item['price'])}'),
                      subtitle: Text('库存 ${item['stock']}'),
                      value: item['id'] as String,
                    ),
                  )
                  .toList(),
            ),
          ),
          asyncButton('加入购物车', addToCart),
          asyncButton('查看购物车', () async {
            await loadCart();
            go('cart');
          }),
          button('继续选购', () => go('catalog', root: true)),
        ];
      case 'cart':
        return [
          text('购物车，共 ${lines.length} 项'),
          ...lines.map((raw) {
            final line = Map<String, dynamic>.from(raw);
            return Card(
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    text('${line['name']} · ${line['variantName']}'),
                    text(
                      '${line['variantId']} 数量 ${line['quantity']}，小计 ${money(line['subtotal'])}',
                    ),
                    Wrap(
                      children: [
                        asyncButton(
                          '增加 ${line['variantId']}',
                          () => changeQuantity(
                            line,
                            (line['quantity'] as int) + 1,
                          ),
                        ),
                        asyncButton(
                          '减少 ${line['variantId']}',
                          () => changeQuantity(
                            line,
                            (line['quantity'] as int) - 1,
                          ),
                        ),
                        button(
                          '删除 ${line['variantId']}',
                          () => confirm(
                            '删除商品',
                            '${line['name']} 将从购物车移除',
                            () => changeQuantity(line, 0),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            );
          }),
          button('填写地址并结算', () {
            quote = null;
            go('checkout');
          }),
          button('继续选购', () => go('catalog', root: true)),
        ];
      case 'checkout':
        return [
          if (cityMode) ...[
            asyncButton('管理收货地址', openNativeAddress),
            button('活动领券', () => go('campaign')),
            DropdownButtonFormField<String>(
              initialValue: deliverySlot,
              decoration: const InputDecoration(labelText: '配送时间'),
              items: ['尽快送达', '今天 18:00–18:30', '今天 19:00–19:30']
                  .map(
                    (slot) => DropdownMenuItem(value: slot, child: Text(slot)),
                  )
                  .toList(),
              onChanged: (slot) => update(() => deliverySlot = slot!),
            ),
            input('platformCoupon', '平台优惠码'),
          ],
          text('收货地址与结算'),
          input('recipient', '收件人'),
          input('phone', '联系电话'),
          input('street', '详细地址'),
          input('coupon', '优惠码'),
          asyncButton('核算金额', calculate),
          if (quote != null) ...[
            text(
              '商品 ${money(quote!['subtotal'])}，优惠 ${money(quote!['discount'])}，运费 ${money(quote!['shipping'])}',
            ),
            text('应付 ${money(quote!['payable'])}'),
            button(
              '提交订单',
              () => confirm(
                '确认订单',
                '应付 ${money(quote!['payable'])}，提交后占用库存',
                submitOrder,
              ),
            ),
          ],
          asyncButton('查询提交结果', () async {
            await refreshOrder();
            if (order != null) {
              go('order');
            }
          }),
          asyncButton('保存草稿', () async {
            await persist();
            update(() => message = '地址和优惠草稿已保存');
          }),
        ];
      case 'order':
        final status =
            {
              'awaiting_payment': '待支付',
              'paid': '已支付',
              'refunded': '已退款',
              'cancelled': '已取消',
            }[order?['status']] ??
            '';
        return [
          text('订单 ${order?['id']}'),
          text('订单状态：$status'),
          if (order != null) text('金额 ${money(order!['payable'])}'),
          asyncButton('查询订单结果', refreshOrder),
          if (order?['status'] == 'awaiting_payment') ...[
            button(
              '支付测试订单',
              () => confirm(
                '确认支付',
                '使用隔离测试账本，金额 ${money(order!['payable'])}',
                pay,
              ),
            ),
            button(
              '取消订单',
              () => confirm('取消订单', '确认释放库存？', () async {
                order =
                    (await api(
                          '/api/shop/orders/${order!['id']}/cancel',
                          {},
                        ))['order']
                        as Map<String, dynamic>;
                await persist();
                update(() {});
              }),
            ),
          ],
          if (order?['status'] == 'paid') button('申请退款', () => go('refund')),
          button(
            '返回商城',
            () => work(() async {
              checkoutKey = '';
              paymentKey = '';
              refundKey = '';
              order = null;
              await persist();
              if (cityMode) {
                await loadShops();
                go('market', root: true);
              } else {
                await loadCatalog();
                go('catalog', root: true);
              }
            }),
          ),
        ];
      case 'refund':
        return [
          text('退款申请'),
          input('refund', '退款原因'),
          button('提交退款申请', () => confirm('确认退款', '原支付金额退回测试账本', refund)),
        ];
      case 'orders':
        return [
          text('订单列表'),
          ...orders.map(
            (item) => ListTile(
              title: Text('订单 ${item['id']}'),
              subtitle: Text('${item['status']} ${money(item['payable'])}'),
              onTap: () {
                order = Map<String, dynamic>.from(item);
                checkoutKey = order!['idempotencyKey'] as String;
                paymentKey = order!['payment']?['key'] as String? ?? '';
                refundKey = order!['refund']?['key'] as String? ?? '';
                go('order');
              },
            ),
          ),
        ];
      case 'account':
        return [
          text('当前账号 ${value('account')}'),
          text('运行 $run'),
          button(
            '继续结算草稿',
            () => work(() async {
              await loadCart();
              quote = null;
              go('checkout');
            }),
          ),
          if (order != null)
            asyncButton('恢复最近订单', () async {
              await refreshOrder();
              go('order');
            }),
          asyncButton('退出登录', () async {
            session = '';
            resumePage = 'catalog';
            await persist();
            go('login', root: true);
          }),
        ];
      case 'inspection':
        return [
          text('跨应用复核'),
          if (inspection != null) ...[
            text('工单 ${inspection!['id']}，版本 ${inspection!['revision']}'),
            text('H5 审核：${inspection!['approved']}'),
            text('Flutter 复核：${inspection!['checked']}'),
            input('checkNote', '复核记录'),
            CheckboxListTile(
              title: const Text('确认现场复核完成'),
              value: reviewAgreement,
              onChanged: (value) => update(() => reviewAgreement = value!),
            ),
            button('提交复核', () {
              if (!reviewAgreement) {
                update(() => message = '请先确认现场复核');
                return;
              }
              confirm('确认复核', '提交复核记录并更新服务端版本', () async {
                inspection =
                    (await api('/api/orders/${inspection!['id']}/check', {
                          'revision': inspection!['revision'],
                          'note': value('checkNote'),
                        }))['order']
                        as Map<String, dynamic>;
                update(() => message = '复核成功');
              });
            }),
          ],
          asyncButton('重新查询工单', loadInspection),
        ];
      default:
        throw StateError('Unknown page $screen');
    }
  }
}
