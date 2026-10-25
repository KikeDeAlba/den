import AppKit
import WebKit

let port = ProcessInfo.processInfo.environment["BITA_MEASURE_PORT"] ?? "8731"
let target = URL(string: "http://127.0.0.1:\(port)/index.html")!

let sizes: [(Double, Double)] = [(900, 600), (1440, 900)]

let probe = """
const W = window.innerWidth;
const H = window.innerHeight;
const sections = ['ahora', 'agentes', 'tiempo', 'docs', 'pendientes', 'reuniones', 'cerebro', 'ajustes'];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const box = (node) => {
  const r = node.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
};
const fmt = (r) => `x=${r.left.toFixed(1)} y=${r.top.toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)}`;
const view = { left: 0, top: 0, right: W, bottom: H };
const problems = [];
const lines = [];
const inside = (name, r, outer) => {
  if (r.left < outer.left - 0.5 || r.top < outer.top - 0.5 || r.right > outer.right + 0.5 || r.bottom > outer.bottom + 0.5) {
    problems.push(`${name} se sale (${fmt(r)})`);
  }
};
for (const id of sections) {
  location.hash = `#/${id}`;
  await wait(600);
  const parts = {};
  for (const selector of ['.shell', '.topbar', '.rail', '.content']) {
    const node = document.querySelector(selector);
    if (!node) { problems.push(`${id}: falta ${selector}`); continue; }
    parts[selector] = box(node);
    inside(`${id} ${selector}`, parts[selector], view);
  }
  const rail = parts['.rail'];
  const bar = parts['.topbar'];
  const content = parts['.content'];
  if (rail && Math.abs(rail.width - 52) > 0.5) problems.push(`${id}: el riel mide ${rail.width} px, no 52`);
  if (bar && Math.abs(bar.height - 38) > 0.5) problems.push(`${id}: la barra mide ${bar.height} px, no 38`);
  if (content && (Math.abs(content.right - W) > 0.5 || Math.abs(content.bottom - H) > 0.5)) {
    problems.push(`${id}: el contenido no llega al borde (${fmt(content)})`);
  }
  if (rail) {
    for (const item of document.querySelectorAll('.rail-item')) inside(`${id} riel ${item.dataset.section}`, box(item), rail);
  }
  const leader = document.querySelector('.leader');
  if (leader && bar) inside(`${id} cronómetro líder`, box(leader), bar);
  const active = document.querySelector('.rail-item[aria-current="page"]');
  if (!active || active.dataset.section !== id) problems.push(`${id}: el riel no marca la sección`);
  const host = document.querySelector(`.section-host[data-section="${id}"]`);
  if (!host || host.hidden) {
    problems.push(`${id}: la sección no está montada`);
  } else if (content) {
    inside(`${id} sección`, box(host), content);
    if (host.scrollWidth > host.clientWidth + 1) problems.push(`${id}: la sección se desborda a lo ancho (${host.scrollWidth} > ${host.clientWidth})`);
    if (id === 'docs') {
      const hostBox = box(host);
      for (const selector of ['.tree-rail', '.reader', '.aside']) {
        const node = host.querySelector(selector);
        if (!node) { problems.push(`docs: falta ${selector}`); continue; }
        inside(`docs ${selector}`, box(node), hostBox);
      }
      const reader = host.querySelector('.reader');
      if (reader && reader.getBoundingClientRect().width < 420) problems.push(`docs: el lector mide ${reader.getBoundingClientRect().width} px, menos de 420`);
    }
  }
  const page = document.documentElement;
  if (page.scrollWidth > W + 1 || page.scrollHeight > H + 1) {
    problems.push(`${id}: la página se desborda (${page.scrollWidth}x${page.scrollHeight})`);
  }
  if (rail && bar && content) lines.push(`${id.padEnd(11)} riel ${fmt(rail)}  barra ${fmt(bar)}  contenido ${fmt(content)}`);
}
return JSON.stringify({ sheets: document.styleSheets.length, problems, lines });
"""

final class Runner: NSObject, WKNavigationDelegate {
    var queue = sizes
    var web: WKWebView?
    var failed = false
    var size: (Double, Double) = (0, 0)

    func next() {
        guard !queue.isEmpty else { exit(failed ? 1 : 0) }
        size = queue.removeFirst()
        let view = WKWebView(
            frame: NSRect(x: 0, y: 0, width: size.0, height: size.1),
            configuration: WKWebViewConfiguration()
        )
        view.navigationDelegate = self
        web = view
        view.load(URLRequest(url: target))
    }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            view.callAsyncJavaScript(probe, arguments: [:], in: nil, in: .page) { result in
                self.report(result)
                self.next()
            }
        }
    }

    func report(_ result: Result<Any, Error>) {
        print(String(format: "— %.0f×%.0f", size.0, size.1))
        guard case let .success(value) = result,
              let text = value as? String,
              let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            print("✗ no pude medir: \(result)")
            failed = true
            return
        }
        if (json["sheets"] as? Int ?? 0) == 0 {
            print("✗ no se cargó ninguna hoja de estilos")
            failed = true
        }
        for line in json["lines"] as? [String] ?? [] { print("  \(line)") }
        let problems = json["problems"] as? [String] ?? []
        for problem in problems { print("✗ \(problem)") }
        if !problems.isEmpty { failed = true }
    }

    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("fallo de carga: \(error)")
        exit(1)
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("fallo de carga: \(error)")
        exit(1)
    }
}

let runner = Runner()
runner.next()

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
