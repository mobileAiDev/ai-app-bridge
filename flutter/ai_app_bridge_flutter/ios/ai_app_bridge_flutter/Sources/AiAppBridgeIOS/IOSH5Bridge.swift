#if canImport(UIKit)
import Foundation
import UIKit
import WebKit

// Owns WebView/document/element identity. JavaScript completion remains owned by
// IOSManagedExecution; cancelling a submitted WebKit evaluation cannot undo it.
final class IOSH5Bridge {
    static let schema = "aab.ios-h5-target/v1"
    private let identifiers = NSMapTable<WKWebView, NSString>.weakToStrongObjects()
    private let runtimeEpoch: String

    init(runtimeEpoch: String) { self.runtimeEpoch = runtimeEpoch }

    private func identifier(_ view: WKWebView) -> String {
        if let id = identifiers.object(forKey: view) { return id as String }
        let id = UUID().uuidString
        identifiers.setObject(id as NSString, forKey: view)
        return id
    }

    private func visible(_ view: UIView) -> Bool {
        guard let window = view.window, !window.isHidden,
              !view.convert(view.bounds, to: window).intersection(window.bounds).isEmpty else { return false }
        var current: UIView? = view
        while let item = current {
            if item.isHidden || item.alpha <= 0.01 || !item.isUserInteractionEnabled { return false }
            current = item.superview
        }
        return true
    }

    private func webViews(_ windows: [UIWindow]) -> [WKWebView] {
        var result: [WKWebView] = []
        func visit(_ view: UIView) {
            if let webView = view as? WKWebView {
                if visible(webView) { result.append(webView) }
                return
            }
            for child in view.subviews { visit(child) }
        }
        for window in windows { visit(window) }
        return result
    }

    private func select(windows: [UIWindow], id: String?) -> (WKWebView?, [String: Any]?) {
        guard UIApplication.shared.applicationState == .active else {
            return (nil, IOSManagedExecution.failure("ios_app_not_active"))
        }
        let views = webViews(windows)
        let matches = id.map { id in views.filter { identifier($0) == id } } ?? views
        guard matches.count == 1 else {
            var error = IOSManagedExecution.failure(matches.isEmpty ? "ios_h5_webview_not_found" : "ios_h5_webview_ambiguous")
            error["webViews"] = views.map { ["webViewId": identifier($0), "url": $0.url?.absoluteString ?? "", "title": $0.title ?? ""] }
            return (nil, error)
        }
        return (matches[0], nil)
    }

    func snapshot(windows: [UIWindow], webViewId: String?, completion: @escaping ([String: Any]) -> Void) {
        let (selected, error) = select(windows: windows, id: webViewId)
        guard let view = selected else { completion(error!); return }
        evaluate(view, request: ["operation": "snapshot", "seed": UUID().uuidString]) { reply in
            guard reply["ok"] as? Bool == true, let dom = reply["dom"] as? [String: Any],
                  let documentId = dom["documentId"] as? String, let url = dom["url"] as? String else {
                completion(reply); return
            }
            let page: [String: Any] = ["schemaVersion": Self.schema, "runtimeEpoch": self.runtimeEpoch,
                "bundleId": Bundle.main.bundleIdentifier ?? "", "processId": Int(ProcessInfo.processInfo.processIdentifier),
                "webViewId": self.identifier(view), "documentId": documentId, "url": url]
            completion(["ok": true, "h5TargetSchema": Self.schema, "pageRef": page, "dom": dom,
                "webView": ["webViewId": self.identifier(view), "url": url, "title": view.title ?? ""],
                "updatedAtMs": Int64(Date().timeIntervalSince1970 * 1000)])
        }
    }

    func execute(windows: [UIWindow], payload: [String: Any], check: @escaping () -> [String: Any],
                 completion: @escaping ([String: Any]) -> Void) {
        guard let page = payload["pageRef"] as? [String: Any],
              page["schemaVersion"] as? String == Self.schema,
              page["runtimeEpoch"] as? String == runtimeEpoch,
              page["bundleId"] as? String == Bundle.main.bundleIdentifier,
              page["processId"] as? Int == Int(ProcessInfo.processInfo.processIdentifier),
              let id = page["webViewId"] as? String else {
            completion(IOSManagedExecution.failure("reobserve_required")); return
        }
        let (selected, error) = select(windows: windows, id: id)
        guard let view = selected else { completion(error!); return }
        let permit = check()
        guard permit["ok"] as? Bool == true else { completion(permit); return }
        var request = payload
        request["operation"] = "action"
        if ["click", "input"].contains(payload["action"] as? String ?? "") {
            var probe = payload
            probe["operation"] = "prepare"
            evaluate(view, request: probe) { prepared in
                guard prepared["ok"] as? Bool == true,
                      let geometry = prepared["geometry"] as? [String: Any] else { completion(prepared); return }
                // UIKit checks the actual DOM action point. The final renderer
                // turn must still match this geometry and the original element.
                let nativeHit = self.checkPoint(view, geometry: geometry)
                guard nativeHit["ok"] as? Bool == true else { completion(nativeHit); return }
                let permit = check()
                guard permit["ok"] as? Bool == true else { completion(permit); return }
                request["geometry"] = geometry
                self.evaluate(view, request: request) { reply in
                    var result = reply
                    result["nativeHit"] = nativeHit
                    completion(result)
                }
            }
        } else {
            guard let window = view.window else { completion(IOSManagedExecution.failure("ios_h5_webview_not_found")); return }
            let point = view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: window)
            guard let hit = window.hitTest(point, with: nil), hit === view || hit.isDescendant(of: view) else {
                completion(IOSManagedExecution.failure("ios_h5_webview_obscured")); return
            }
            evaluate(view, request: request, completion: completion)
        }
    }

    private func checkPoint(_ view: WKWebView, geometry: [String: Any]) -> [String: Any] {
        guard let x = geometry["x"] as? Double, let y = geometry["y"] as? Double,
              let width = geometry["width"] as? Double, let height = geometry["height"] as? Double,
              let scrollX = geometry["scrollX"] as? Double, let scrollY = geometry["scrollY"] as? Double,
              [x, y, width, height, scrollX, scrollY].allSatisfy({ $0.isFinite }), width > 0, height > 0 else {
            return IOSManagedExecution.failure("ios_h5_viewport_invalid")
        }
        guard let window = view.window, visible(view), UIApplication.shared.applicationState == .active else {
            return IOSManagedExecution.failure("ios_h5_webview_not_available")
        }
        let scrollView = view.scrollView
        guard !scrollView.isZooming, !scrollView.isZoomBouncing, !scrollView.isDragging,
              !scrollView.isDecelerating else { return IOSManagedExecution.failure("reobserve_required") }
        if #available(iOS 14.0, *), view.pageZoom != 1 {
            return IOSManagedExecution.failure("ios_h5_page_zoom_unsupported")
        }
        // DOM client coordinates plus the DOM scroll offset are document coordinates.
        // UIScrollView already owns native insets/offsets; convert from its scaled content
        // coordinates instead of equating innerHeight with the unobscured native height.
        let scale = scrollView.zoomScale
        let point = scrollView.convert(CGPoint(x: (x + scrollX) * scale, y: (y + scrollY) * scale), to: window)
        let details: [String: Any] = ["point": ["x": point.x, "y": point.y], "zoomScale": scale,
            "contentOffset": ["x": scrollView.contentOffset.x, "y": scrollView.contentOffset.y], "geometry": geometry]
        func reject(_ code: String) -> [String: Any] {
            var reply = IOSManagedExecution.failure(code)
            reply["nativeHit"] = details
            return reply
        }
        guard view.convert(view.bounds, to: window).contains(point),
              scrollView.convert(scrollView.bounds, to: window).contains(point) else {
            return reject("ios_h5_target_outside_native_viewport")
        }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }.flatMap { $0.windows }
        for candidate in windows where candidate !== window && !candidate.isHidden && candidate.alpha > 0.01
            && (candidate.windowLevel > window.windowLevel || candidate.isKeyWindow) {
            let other = candidate.convert(point, from: window)
            if candidate.hitTest(other, with: nil) != nil { return reject("ios_h5_native_target_obscured") }
        }
        guard let hit = window.hitTest(point, with: nil), hit === view || hit.isDescendant(of: view) else {
            return reject("ios_h5_native_target_obscured")
        }
        return details.merging(["ok": true, "hitClass": NSStringFromClass(type(of: hit))]) { _, value in value }
    }

    private func evaluate(_ view: WKWebView, request: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        guard let data = try? JSONSerialization.data(withJSONObject: request), let json = String(data: data, encoding: .utf8) else {
            completion(IOSManagedExecution.failure("invalid_h5_operation")); return
        }
        view.evaluateJavaScript("(\(Self.renderer))(\(json))") { value, error in
            if let error {
                // WebKit may lose the callback after navigation/process exit.
                // No matching JS receipt means the effect is still uncertain.
                completion(["ok": false, "error": "ios_h5_evaluation_failed", "message": error.localizedDescription,
                    "dispatched": request["operation"] as? String == "action", "ambiguous": true]); return
            }
            guard let reply = value as? [String: Any], reply["ok"] is Bool else {
                completion(["ok": false, "error": "invalid_ios_h5_reply", "dispatched": true, "ambiguous": true]); return
            }
            completion(reply)
        }
    }

    // Tested by executing this exact source in the Host DOM tests.
    static let renderer = #"""
    (function(request) {
      const key = '__aabIOSH5TargetV1';
      const fail = (error, dispatched = false) => ({ok:false,error,dispatched,ambiguous:false});
      let state = window[key];
      if (request.operation === 'snapshot' && !state) {
        state = {document, documentId:request.seed, generation:0, sequence:0, nodes:new WeakMap(), suspended:false};
        Object.defineProperty(window,key,{value:state});
        window.addEventListener('pagehide',()=>{state.suspended=true;});
        window.addEventListener('pageshow',()=>{state.documentId=request.seed+':'+(++state.generation);state.suspended=false;});
        for (const method of ['pushState','replaceState']) {
          const original=history[method];history[method]=function(...args){const result=original.apply(this,args);state.documentId=request.seed+':'+(++state.generation);return result;};
        }
        for (const event of ['popstate','hashchange']) window.addEventListener(event,()=>{state.documentId=request.seed+':'+(++state.generation);});
      }
      if (!state || state.document !== document || state.suspended) return fail('reobserve_required');
      const str = value => value == null ? '' : String(value);
      const secure = e => /password|passwd|pwd|passcode/.test([e.type,e.id,e.name,e.autocomplete].join(' ').toLowerCase());
      const bounds = e => {const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const visible = e => {const s=getComputedStyle(e),r=bounds(e);return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&Number(s.opacity)!==0&&r.width>0&&r.height>0;};
      const ref = e => {
        if (!state.nodes.has(e)) state.nodes.set(e,'e'+(++state.sequence));
        return {elementId:state.nodes.get(e),tag:e.tagName.toLowerCase(),id:str(e.id),name:str(e.getAttribute('name')),
          type:str(e.getAttribute('type')),text:secure(e)?'':str(e.innerText).slice(0,500),
          ariaLabel:str(e.getAttribute('aria-label')),href:str(e.href)};
      };
      const controls = () => Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[onclick],[aria-label],[contenteditable="true"]'));
      const disabled = e => !!e.disabled || e.getAttribute('aria-disabled')==='true';
      const editable = e => !disabled(e) && !e.readOnly && (e.isContentEditable===true || e.tagName==='TEXTAREA'
        || e.tagName==='INPUT'&&['text','search','url','tel','email','password','number'].includes(e.type));
      const interaction = e => {
        if (disabled(e)) return {status:'disabled'};
        if (!visible(e)) return {status:'hidden'};
        const r=bounds(e),left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
        if (right<=left||bottom<=top) return {status:'outside-viewport'};
        const point={x:(left+right)/2,y:(top+bottom)/2},hit=document.elementFromPoint(point.x,point.y);
        return hit&&(hit===e||e.contains(hit)) ? {status:'ready',point} : {status:'obscured',point};
      };
      if (request.operation === 'snapshot') {
        const all=controls(), body=str(document.body&&document.body.innerText);
        return {ok:true,dom:{documentId:state.documentId,url:location.href,title:document.title,readyState:document.readyState,
          viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},
          bodyText:body.slice(0,20000),bodyTextTruncated:body.length>20000,controlCount:all.length,truncated:all.length>1000,
          controls:all.slice(0,1000).map(e=>({...ref(e),value:secure(e)?'[REDACTED]':str(e.value).slice(0,500),
            visible:visible(e),disabled:disabled(e),editable:editable(e),interaction:interaction(e),bounds:bounds(e)}))}};
      }
      const page=request.pageRef;
      if (!page || page.documentId!==state.documentId || page.url!==location.href) return fail('reobserve_required');
      if (request.action==='eval') {
        try {return {ok:true,result:(0,eval)(request.script),dispatched:true,ambiguous:false};}
        catch(error){return {ok:false,error:'h5_script_failed',message:str(error.message),dispatched:true,ambiguous:false};}
      }
      if (request.action==='scrollBy') {
        window.scrollBy({left:request.deltaX,top:request.deltaY,behavior:'instant'});
        return {ok:true,dispatched:true,ambiguous:false,scrollX,scrollY};
      }
      const all=controls();
      if (all.length>5000) return fail('ios_h5_target_scan_truncated');
      const expected=request.element;
      const selected=all.filter(e=>state.nodes.get(e)===expected?.elementId);
      if (selected.length!==1) return fail('reobserve_required');
      const element=selected[0];
      const current = () => document.documentElement.contains(element)&&page.documentId===state.documentId&&page.url===location.href
        &&Object.entries(ref(element)).every(([key,value])=>expected[key]===value)&&!disabled(element)&&visible(element);
      if (!current()) return fail('reobserve_required');
      if (request.action==='scroll') {
        element.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        return {ok:true,dispatched:true,ambiguous:false,element:ref(element),bounds:bounds(element),interaction:interaction(element)};
      }
      const reachability=interaction(element);
      if (reachability.status==='outside-viewport') return fail('ios_h5_target_outside_viewport');
      if (reachability.status!=='ready') return fail('ios_h5_target_obscured');
      const r=bounds(element),{x,y}=reachability.point;
      const geometry={x,y,width:innerWidth,height:innerHeight,scrollX,scrollY,bounds:r};
      if (request.operation==='prepare') return {ok:true,geometry,dispatched:false,ambiguous:false};
      if (!request.geometry || !['x','y','width','height','scrollX','scrollY'].every(key=>geometry[key]===request.geometry[key]) || !request.geometry.bounds || !Object.keys(r).every(key=>r[key]===request.geometry.bounds[key])) return fail('reobserve_required');
      if (request.action==='click') {
        if (typeof element.click!=='function') return fail('ios_h5_target_not_clickable');
        element.click();return {ok:true,dispatched:true,ambiguous:false,element:expected};
      }
      if (request.action==='input') {
        const tag=element.tagName.toLowerCase(), valueControl=tag==='input'||tag==='textarea';
        if (!editable(element)) return fail('ios_h5_target_not_editable');
        const before=valueControl?element.value:element.innerText;
        element.focus();
        if (!current()||!editable(element)||(valueControl?element.value:element.innerText)!==before) return fail('ios_h5_target_changed',true);
        if (valueControl) Object.getOwnPropertyDescriptor(tag==='input'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value').set.call(element,request.text);
        else element.innerText=request.text;
        element.dispatchEvent(new Event('input',{bubbles:true}));
        if (!document.documentElement.contains(element)) return fail('ios_h5_target_changed',true);
        element.dispatchEvent(new Event('change',{bubbles:true}));
        return {ok:true,dispatched:true,ambiguous:false,element:expected};
      }
      return fail('invalid_h5_operation');
    })
    """#
}
#endif
