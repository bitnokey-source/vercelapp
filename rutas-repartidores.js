/* rutas-repartidores.js — Productos de la Costa
 * Módulo independiente: asigna repartidor/vehículo/zona/fecha a una ruta,
 * maneja estados (pendiente → en_curso → completada/cancelada) y
 * geolocalización en vivo (inicio, fin, tracking mientras está en curso).
 *
 * No modifica index.html ni la colección `rutas` que ya usa la pantalla
 * "Ruta de reparto" (cargar camión / entregas). Guarda su propia
 * colección `rutas_meta` en Firestore, así que es 100% aditivo.
 *
 * Integración en index.html: agrega esta línea justo después del
 * <script type="text/babel"> principal (antes del script de registro
 * del Service Worker):
 *
 *   <script type="text/babel" src="./rutas-repartidores.js"></script>
 */
(function () {
  'use strict';

  // ---- Carga de Leaflet (mapa) bajo demanda, sin tocar el <head> original ----
  let leafletLoading = false;
  function ensureLeaflet(cb) {
    if (window.L) { cb(); return; }
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    if (leafletLoading) {
      const check = setInterval(() => { if (window.L) { clearInterval(check); cb(); } }, 200);
      return;
    }
    leafletLoading = true;
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => { leafletLoading = false; cb(); };
    script.onerror = () => { leafletLoading = false; cb(); };
    document.body.appendChild(script);
  }

  // ---- Carga de QRCode.js (generación de QR) bajo demanda ----
  let qrLibLoading = false;
  function ensureQRCodeLib(cb) {
    if (window.QRCode) { cb(); return; }
    if (qrLibLoading) { const check = setInterval(() => { if (window.QRCode) { clearInterval(check); cb(); } }, 200); return; }
    qrLibLoading = true;
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    script.onload = () => { qrLibLoading = false; cb(); };
    script.onerror = () => { qrLibLoading = false; cb(); };
    document.body.appendChild(script);
  }
  const QR_PREFIX = 'PDLC-CLIENTE:';
  const qrTextForCliente = id => QR_PREFIX + id;
  function parseClienteQR(text) {
    if (!text) return null;
    return text.startsWith(QR_PREFIX) ? text.slice(QR_PREFIX.length) : text;
  }
  function renderQRDataURL(text, size, cb) {
    ensureQRCodeLib(() => {
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
      document.body.appendChild(holder);
      try {
        new window.QRCode(holder, { text, width: size, height: size, correctLevel: window.QRCode.CorrectLevel.M });
        setTimeout(() => {
          const canvas = holder.querySelector('canvas');
          const img = holder.querySelector('img');
          const url = canvas ? canvas.toDataURL('image/png') : (img ? img.src : null);
          document.body.removeChild(holder);
          cb(url);
        }, 150);
      } catch (e) { document.body.removeChild(holder); cb(null); }
    });
  }


  const fbApp = firebase.app();
  const dbx = fbApp.firestore();
  const authx = fbApp.auth();

  const { useState, useEffect, useRef } = React;

  const fDateTime = d => d ? new Date(d).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const fmtx = n => '$' + Number(n || 0).toFixed(2);

  // ---- Comprobante / guía de ruta ----
  function itemsCargadosDe(r) {
    if (Array.isArray(r.items)) return r.items.map(it => ({ nombre: it.nombre, cant: it.cant }));
    return Object.values(r.items || {}).map(it => ({ nombre: it.nombre, cant: it.cantCargada }));
  }
  function resumenRuta(r) {
    const entregas = r.entregas || [];
    const totalVendido = entregas.reduce((s, e) => s + (e.total || 0), 0);
    return { entregas, totalVendido, cargados: itemsCargadosDe(r) };
  }
  function guiaHTML(r) {
    const { entregas, totalVendido, cargados } = resumenRuta(r);
    const filasCargados = cargados.map(it => `<tr><td>${it.nombre}</td><td style="text-align:right">${it.cant}</td></tr>`).join('');
    const filasEntregas = entregas.map(e => `<tr><td>${e.clienteNombre}</td><td>${(e.items || []).length} prod.</td><td>${e.formaPago}</td><td style="text-align:right">${fmtx(e.total)}</td></tr>`).join('');
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Guía de ruta — ${fDateTime(r.fecha)}</title>
      <style>
        *{box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}
        body{padding:24px;color:#0f172a;max-width:640px;margin:0 auto}
        h1{font-size:20px;margin-bottom:2px}
        h2{font-size:13px;color:#475569;font-weight:600;margin:20px 0 8px;text-transform:uppercase;letter-spacing:.5px}
        .sub{color:#64748b;font-size:13px;margin-bottom:16px}
        table{width:100%;border-collapse:collapse;font-size:13px}
        td,th{padding:6px 4px;border-bottom:1px solid #e2e8f0;text-align:left}
        .total{font-size:18px;font-weight:800;text-align:right;margin-top:10px}
        @media print{ button{display:none} }
      </style></head><body>
      <h1>🚚 Guía de ruta</h1>
      <div class="sub">${fDateTime(r.fecha)} · Estado: ${r.estado === 'activa' ? 'en curso' : (r.estado || 'cerrada')}</div>
      <h2>Productos cargados</h2>
      <table>${filasCargados || '<tr><td>Sin productos</td></tr>'}</table>
      <h2>Entregas (${entregas.length})</h2>
      <table>${filasEntregas || '<tr><td>Sin entregas registradas</td></tr>'}</table>
      <div class="total">Total vendido: ${fmtx(totalVendido)}</div>
      <button onclick="window.print()" style="margin-top:20px;background:#38bdf8;border:none;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer">🖨️ Imprimir</button>
      </body></html>`;
  }
  function imprimirGuia(r) {
    const w = window.open('', '_blank');
    if (!w) { alert('Habilita las ventanas emergentes para imprimir la guía.'); return; }
    w.document.write(guiaHTML(r));
    w.document.close();
  }
  function waGuiaLink(r, telefono) {
    const { entregas, totalVendido, cargados } = resumenRuta(r);
    const lineasCarga = cargados.map(it => `• ${it.nombre} x${it.cant}`).join('\n');
    const lineasEnt = entregas.map(e => `• ${e.clienteNombre}: ${fmtx(e.total)} (${e.formaPago})`).join('\n');
    const texto = `🚚 *GUÍA DE RUTA*\n📅 ${fDateTime(r.fecha)}\n\n*Cargamento:*\n${lineasCarga || 'Sin productos'}\n\n*Entregas (${entregas.length}):*\n${lineasEnt || 'Sin entregas'}\n\n💰 *Total vendido: ${fmtx(totalVendido)}*`;
    let tel = (telefono || '').replace(/\D/g, '');
    if (tel && !tel.startsWith('52') && tel.length <= 10) tel = '52' + tel;
    return `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;
  }

  function waVentaLink(cliente, items, total, pago) {
    const lineas = items.map(it => `• ${it.nombre} x${it.cant} = ${fmtx((it.precio || 0) * it.cant)}`).join('\n');
    const texto = `🧾 *PEDIDO*\n👤 ${cliente.nombre}\n\n${lineas}\n\n💰 *Total: ${fmtx(total)}*\nPago: ${pago}`;
    let tel = (cliente.telefono || '').replace(/\D/g, '');
    if (tel && !tel.startsWith('52') && tel.length <= 10) tel = '52' + tel;
    return `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;
  }

  const ESTADOS = {
    pendiente: { label: 'Pendiente', color: '#94a3b8' },
    en_curso: { label: 'En curso', color: '#38bdf8' },
    completada: { label: 'Completada', color: '#22c55e' },
    cancelada: { label: 'Cancelada', color: '#ef4444' },
  };

  function getLoc() {
    return new Promise(res => {
      if (!navigator.geolocation) { res(null); return; }
      navigator.geolocation.getCurrentPosition(
        p => res({ lat: p.coords.latitude, lng: p.coords.longitude, fecha: new Date().toISOString() }),
        () => res(null),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
  }

  const inputStyle = { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '8px 10px', color: '#f1f5f9', fontSize: 13, width: '100%', boxSizing: 'border-box', marginBottom: 10 };
  const lblStyle = { fontSize: 11, color: '#94a3b8', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.5px' };
  const uidx = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function totalesParadas(paradas) {
    const map = {};
    (paradas || []).forEach(p => (p.items || []).forEach(it => {
      map[it.id] = map[it.id] || { nombre: it.nombre, cant: 0 };
      map[it.id].cant += it.cant;
    }));
    return Object.values(map);
  }

  // ---- Armador de paradas: elige cliente + productos a llevar ----
  function ParadaBuilder({ clientes, productos, paradas, onChange }) {
    const [cliSearch, setCliSearch] = useState('');
    const [cliSel, setCliSel] = useState(null);
    const [prodSearch, setProdSearch] = useState('');
    const [draftItems, setDraftItems] = useState([]);
    const cliFilt = clientes.filter(c => c.activo && c.nombre.toLowerCase().includes(cliSearch.toLowerCase()));
    const prodFilt = productos.filter(p => p.nombre.toLowerCase().includes(prodSearch.toLowerCase()));

    const addProd = p => setDraftItems(items => {
      const ex = items.find(x => x.id === p.id);
      return ex ? items.map(x => x.id === p.id ? { ...x, cant: x.cant + 1 } : x) : [...items, { id: p.id, nombre: p.nombre, cant: 1 }];
    });
    const updQty = (id, v) => { if (v < 1) { setDraftItems(items => items.filter(x => x.id !== id)); return; } setDraftItems(items => items.map(x => x.id === id ? { ...x, cant: v } : x)); };

    const agregarParada = () => {
      if (!cliSel || draftItems.length === 0) return;
      onChange([...(paradas || []), { id: uidx(), clienteId: cliSel.id, clienteNombre: cliSel.nombre, clienteTelefono: cliSel.telefono || '', items: draftItems, visitado: false }]);
      setCliSel(null); setCliSearch(''); setDraftItems([]); setProdSearch('');
    };
    const quitarParada = id => onChange((paradas || []).filter(p => p.id !== id));

    return (
      <div>
        {(paradas || []).length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {paradas.map((p, i) => (
              <div key={p.id} style={{ background: '#0f172a', borderRadius: 8, padding: '8px 10px', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{i + 1}. {p.clienteNombre}</div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>{p.items.map(it => `${it.nombre} x${it.cant}`).join(', ')}</div>
                </div>
                <button onClick={() => quitarParada(p.id)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 14 }}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div style={lblStyle}>Cliente a visitar</div>
        {cliSel ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#0f172a', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: '#38bdf8', fontWeight: 700 }}>{cliSel.nombre}</span>
            <button onClick={() => setCliSel(null)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>✕</button>
          </div>
        ) : (
          <>
            <input value={cliSearch} onChange={e => setCliSearch(e.target.value)} placeholder="Buscar cliente…" style={inputStyle} />
            <div style={{ maxHeight: 130, overflowY: 'auto', marginBottom: 10 }}>
              {cliFilt.map(c => (
                <div key={c.id} onClick={() => setCliSel(c)} style={{ padding: '7px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>{c.nombre}</div>
              ))}
            </div>
          </>
        )}
        {cliSel && <>
          <div style={lblStyle}>Productos a llevar</div>
          <input value={prodSearch} onChange={e => setProdSearch(e.target.value)} placeholder="Buscar producto…" style={inputStyle} />
          <div style={{ maxHeight: 130, overflowY: 'auto', marginBottom: 10 }}>
            {prodFilt.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #0f172a' }}>
                <span style={{ fontSize: 12 }}>{p.nombre}</span>
                <button onClick={() => addProd(p)} style={{ background: '#172554', color: '#60a5fa', border: 'none', borderRadius: 6, padding: '3px 9px', fontSize: 11, cursor: 'pointer' }}>+ Agregar</button>
              </div>
            ))}
          </div>
          {draftItems.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {draftItems.map(it => (
                <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, flex: 1 }}>{it.nombre}</span>
                  <button onClick={() => updQty(it.id, it.cant - 1)} style={{ background: '#334155', border: 'none', color: '#f1f5f9', borderRadius: 6, width: 22, height: 22, cursor: 'pointer' }}>-</button>
                  <input type="number" min="1" value={it.cant} onChange={e => { const v = e.target.value; if (v === '') return; const n = parseInt(v); if (!isNaN(n) && n >= 1) updQty(it.id, n); }} onBlur={e => { if (!e.target.value || parseInt(e.target.value) < 1) updQty(it.id, 1); }} style={{ width: 36, textAlign: 'center', fontSize: 12, background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: '#f1f5f9', padding: '3px 2px' }} />
                  <button onClick={() => updQty(it.id, it.cant + 1)} style={{ background: '#334155', border: 'none', color: '#f1f5f9', borderRadius: 6, width: 22, height: 22, cursor: 'pointer' }}>+</button>
                </div>
              ))}
              <button onClick={agregarParada} style={{ width: '100%', background: '#166534', color: '#4ade80', border: 'none', borderRadius: 8, padding: 9, fontWeight: 700, cursor: 'pointer', fontSize: 12, marginTop: 4 }}>✓ Agregar parada</button>
            </div>
          )}
        </>}
      </div>
    );
  }

  function imprimirQRHTML(cliente, dataURL) {
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>QR — ${cliente.nombre}</title>
      <style>
        *{box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}
        body{padding:24px;color:#0f172a;text-align:center}
        img{width:240px;height:240px;margin:12px auto}
        h1{font-size:18px;margin-bottom:2px}
        p{color:#475569;font-size:13px}
        @media print{ button{display:none} }
      </style></head><body>
      <h1>${cliente.nombre}</h1>
      <p>${cliente.telefono || ''}${cliente.domicilio ? ' · ' + cliente.domicilio : ''}</p>
      ${dataURL ? `<img src="${dataURL}"/>` : '<p>No se pudo generar el QR</p>'}
      <p>Escanea este código al entregar para abrir la nota de este cliente.</p>
      <button onclick="window.print()" style="margin-top:14px;background:#38bdf8;border:none;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer">🖨️ Imprimir</button>
      </body></html>`;
  }
  function imprimirQR(cliente, dataURL) {
    const w = window.open('', '_blank');
    if (!w) { alert('Habilita las ventanas emergentes para imprimir el QR.'); return; }
    w.document.write(imprimirQRHTML(cliente, dataURL));
    w.document.close();
  }

  // ---- Escáner de QR de cliente (usa Html5Qrcode, ya cargado por index.html) ----
  function ClienteScanner({ onDetected, onClose }) {
    const [elId] = useState(() => 'cli-scanner-' + uidx());
    const [err, setErr] = useState('');
    useEffect(() => {
      if (typeof window.Html5Qrcode === 'undefined') { setErr('No se pudo cargar la librería de escaneo.'); return; }
      let scanner = null, stopped = false, cancelled = false;
      (async () => {
        try {
          scanner = new window.Html5Qrcode(elId);
          await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } },
            decodedText => {
              if (stopped || cancelled) return;
              stopped = true;
              scanner.stop().then(() => scanner.clear()).catch(() => {});
              onDetected(decodedText);
            }, () => {});
        } catch (e) { if (!cancelled) setErr('No se pudo acceder a la cámara. Revisa los permisos del navegador.'); }
      })();
      return () => {
        cancelled = true;
        if (scanner && !stopped) { stopped = true; try { scanner.stop().then(() => scanner.clear()).catch(() => {}); } catch (e) {} }
      };
    }, []);
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#000c', zIndex: 320, display: 'flex', alignItems: 'flex-end' }}>
        <div style={{ background: '#1e293b', width: '100%', maxWidth: 420, margin: '0 auto', borderRadius: '18px 18px 0 0', padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <span style={{ fontSize: 16, fontWeight: 700 }}>📷 Escanear QR de cliente</span>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 20, cursor: 'pointer' }}>✕</button>
          </div>
          {err ? <div style={{ fontSize: 13, color: '#f87171', textAlign: 'center', padding: '24px 0' }}>{err}</div>
            : <div id={elId} style={{ width: '100%', borderRadius: 10, overflow: 'hidden', background: '#000' }} />}
        </div>
      </div>
    );
  }


  function RepartidoresPanel() {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState('activas');
    const [currentUser, setCurrentUser] = useState(null);
    const [usuarios, setUsuarios] = useState([]);
    const [rutas, setRutas] = useState([]);
    const [rutasReales, setRutasReales] = useState([]);
    const [productos, setProductos] = useState([]);
    const [clientes, setClientes] = useState([]);
    const [planEditFor, setPlanEditFor] = useState(null);
    const [expandPlan, setExpandPlan] = useState(null);
    const [waFor, setWaFor] = useState(null);
    const [waPhone, setWaPhone] = useState('');
    const [expandComp, setExpandComp] = useState(null);
    const [form, setForm] = useState(null);
    const [msg, setMsg] = useState('');
    const [mapReady, setMapReady] = useState(false);
    const mapRef = useRef(null);
    const mapInstance = useRef(null);
    const markersRef = useRef({});
    const watchIdRef = useRef(null);
    const [tracking, setTracking] = useState(null);
    const [qrModalFor, setQrModalFor] = useState(null);
    const [qrDataURL, setQrDataURL] = useState(null);
    const [clienteScanOpen, setClienteScanOpen] = useState(false);
    const [clienteBuscarOpen, setClienteBuscarOpen] = useState(false);
    const [cliQSearch, setCliQSearch] = useState('');
    const [nuevoCliForm, setNuevoCliForm] = useState(null);
    const [ventaRapida, setVentaRapida] = useState(null); // {cliente, items, pago, ubicacion, saving}
    const [ventaProdSearch, setVentaProdSearch] = useState('');

    const flash = m => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

    useEffect(() => {
      const unsub = authx.onAuthStateChanged(async u => {
        if (!u) { setCurrentUser(null); return; }
        try {
          const snap = await dbx.collection('usuarios').doc(u.uid).get();
          setCurrentUser({ uid: u.uid, ...(snap.exists ? snap.data() : { nombre: u.email, email: u.email, role: 'usuario' }) });
        } catch (e) {
          setCurrentUser({ uid: u.uid, nombre: u.email, email: u.email, role: 'usuario' });
        }
      });
      return unsub;
    }, []);

    useEffect(() => {
      if (!currentUser) return;
      const unsub = dbx.collection('rutas_meta').orderBy('fechaCreacion', 'desc').limit(200)
        .onSnapshot(snap => setRutas(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
      let unsubU = () => {};
      if (currentUser.role === 'admin') {
        unsubU = dbx.collection('usuarios').onSnapshot(snap => setUsuarios(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
      }
      const unsubR = dbx.collection('rutas').orderBy('fecha', 'desc').limit(100)
        .onSnapshot(snap => setRutasReales(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
      const unsubP = dbx.collection('productos').onSnapshot(snap => setProductos(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
      const unsubC = dbx.collection('clientes').onSnapshot(snap => setClientes(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
      return () => { unsub(); unsubU(); unsubR(); unsubP(); unsubC(); };
    }, [currentUser]);

    const actualizarParadas = async (rutaId, nuevasParadas) => {
      try { await dbx.collection('rutas_meta').doc(rutaId).update({ paradas: nuevasParadas }); }
      catch (e) { flash('❌ ' + e.message); }
    };

    const [confirmFor, setConfirmFor] = useState(null); // {rutaId, paradaId}
    const [confirmItems, setConfirmItems] = useState([]);
    const [confirmPago, setConfirmPago] = useState('contado');
    const [confirmSaving, setConfirmSaving] = useState(false);

    const abrirConfirmacion = (r, p) => {
      setConfirmFor({ rutaId: r.id, paradaId: p.id });
      setConfirmItems(p.items.map(it => ({ ...it })));
      setConfirmPago('contado');
    };
    const updConfirmQty = (id, v) => {
      if (v < 1) { setConfirmItems(items => items.filter(x => x.id !== id)); return; }
      setConfirmItems(items => items.map(x => x.id === id ? { ...x, cant: v } : x));
    };

    const confirmarEntrega = async (r, p) => {
      if (confirmItems.length === 0) { flash('⚠️ Agrega al menos un producto'); return; }
      setConfirmSaving(true);
      try {
        const faltantes = [];
        confirmItems.forEach(item => {
          const prod = productos.find(x => x.id === item.id);
          if (!prod || prod.stock < item.cant) faltantes.push(`${item.nombre} (disp: ${prod ? prod.stock : 0}, pedido: ${item.cant})`);
        });
        if (faltantes.length > 0) { flash('❌ Sin stock: ' + faltantes.join(', ')); setConfirmSaving(false); return; }

        const total = confirmItems.reduce((s, it) => {
          const prod = productos.find(x => x.id === it.id);
          return s + (prod ? prod.precio : 0) * it.cant;
        }, 0);
        const itemsConPrecio = confirmItems.map(it => {
          const prod = productos.find(x => x.id === it.id);
          return { id: it.id, nombre: it.nombre, cant: it.cant, precio: prod ? prod.precio : 0 };
        });

        const batch = dbx.batch();
        const notaRef = dbx.collection('notas').doc();
        batch.set(notaRef, {
          fecha: new Date().toISOString(), clienteId: p.clienteId, clienteNombre: p.clienteNombre,
          clienteTelefono: p.clienteTelefono || '', items: itemsConPrecio, total, formaPago: confirmPago,
          rutaMetaId: r.id,
        });
        if (confirmPago === 'credito') {
          batch.set(dbx.collection('creditos').doc(), {
            notaId: notaRef.id, clienteId: p.clienteId, clienteNombre: p.clienteNombre,
            fecha: new Date().toISOString(), total, saldo: total, abonos: [],
          });
        }
        itemsConPrecio.forEach(it => {
          batch.update(dbx.collection('productos').doc(it.id), { stock: firebase.firestore.FieldValue.increment(-it.cant) });
        });
        await batch.commit();

        const nuevas = (r.paradas || []).map(x => x.id === p.id
          ? { ...x, visitado: true, notaId: notaRef.id, totalEntregado: total, formaPago: confirmPago, fechaEntrega: new Date().toISOString() }
          : x);
        await actualizarParadas(r.id, nuevas);
        setConfirmFor(null);
        flash('✅ Entrega registrada — ' + fmtx(total));
      } catch (e) { flash('❌ ' + e.message); }
      setConfirmSaving(false);
    };

    // ---- Mapa ----
    useEffect(() => {
      if (!open || tab !== 'mapa') return;
      ensureLeaflet(() => {
        if (!window.L || !mapRef.current) return;
        setTimeout(() => {
          if (!mapInstance.current && mapRef.current) {
            mapInstance.current = window.L.map(mapRef.current).setView([23.6, -102.5], 5);
            window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(mapInstance.current);
          }
          setMapReady(true);
          if (mapInstance.current) setTimeout(() => mapInstance.current.invalidateSize(), 100);
        }, 50);
      });
    }, [open, tab]);

    useEffect(() => {
      if (!mapReady || !mapInstance.current) return;
      const activas = rutas.filter(r => r.estado === 'en_curso' && r.ubicacionActual);
      Object.keys(markersRef.current).forEach(id => {
        if (!activas.find(r => r.id === id)) { mapInstance.current.removeLayer(markersRef.current[id]); delete markersRef.current[id]; }
      });
      const pts = [];
      activas.forEach(r => {
        const { lat, lng } = r.ubicacionActual;
        pts.push([lat, lng]);
        const popup = `<b>${r.repartidorNombre || '—'}</b><br/>${r.vehiculo || ''}<br/>${r.zona || ''}`;
        if (markersRef.current[r.id]) {
          markersRef.current[r.id].setLatLng([lat, lng]).setPopupContent(popup);
        } else {
          markersRef.current[r.id] = window.L.marker([lat, lng]).addTo(mapInstance.current).bindPopup(popup);
        }
      });
      if (pts.length) mapInstance.current.fitBounds(pts, { maxZoom: 14, padding: [30, 30] });
    }, [rutas, mapReady]);

    const crear = async () => {
      if (!form.repartidorNombre) { flash('⚠️ Falta el repartidor'); return; }
      try {
        await dbx.collection('rutas_meta').add({
          repartidorId: form.repartidorId || currentUser.uid,
          repartidorNombre: form.repartidorNombre,
          vehiculo: form.vehiculo || '',
          zona: form.zona || '',
          fechaProgramada: form.fechaProgramada ? new Date(form.fechaProgramada).toISOString() : '',
          fechaRegresoProgramada: form.fechaRegresoProgramada ? new Date(form.fechaRegresoProgramada).toISOString() : '',
          estado: 'pendiente',
          fechaCreacion: new Date().toISOString(),
          paradas: form.paradas || [],
        });
        setForm(null);
        flash('✅ Ruta programada');
      } catch (e) { flash('❌ ' + e.message); }
    };

    const iniciar = async r => {
      const loc = await getLoc();
      try {
        await dbx.collection('rutas_meta').doc(r.id).update({
          estado: 'en_curso',
          fechaSalidaReal: new Date().toISOString(),
          ...(loc ? { ubicacionInicio: loc, ubicacionActual: loc } : {}),
        });
        flash('🚀 Ruta iniciada');
      } catch (e) { flash('❌ ' + e.message); }
    };

    const completar = async r => {
      if (tracking === r.id) detenerSeguimiento();
      const loc = await getLoc();
      try {
        await dbx.collection('rutas_meta').doc(r.id).update({
          estado: 'completada',
          fechaRegresoReal: new Date().toISOString(),
          ...(loc ? { ubicacionFin: loc } : {}),
        });
        flash('🏁 Ruta completada');
      } catch (e) { flash('❌ ' + e.message); }
    };

    const cancelar = async r => {
      if (!confirm('¿Cancelar esta ruta programada?')) return;
      await dbx.collection('rutas_meta').doc(r.id).update({ estado: 'cancelada' });
      flash('Ruta cancelada');
    };

    // ---- QR de cliente ----
    const verQR = cliente => {
      setQrModalFor(cliente); setQrDataURL(null);
      renderQRDataURL(qrTextForCliente(cliente.id), 260, url => setQrDataURL(url));
    };

    const crearClienteRapido = async () => {
      if (!nuevoCliForm.nombre) { flash('⚠️ Falta el nombre'); return; }
      try {
        const ref = await dbx.collection('clientes').add({
          nombre: nuevoCliForm.nombre, telefono: nuevoCliForm.telefono || '', domicilio: nuevoCliForm.domicilio || '', activo: true,
        });
        setNuevoCliForm(null);
        flash('✅ Cliente creado');
        verQR({ id: ref.id, nombre: nuevoCliForm.nombre, telefono: nuevoCliForm.telefono || '', domicilio: nuevoCliForm.domicilio || '' });
      } catch (e) { flash('❌ ' + e.message); }
    };

    // ---- Venta rápida (escaneo QR o búsqueda manual) ----
    const abrirVentaParaCliente = cliente => {
      setClienteScanOpen(false); setClienteBuscarOpen(false); setCliQSearch('');
      setVentaRapida({ cliente, items: [], pago: 'contado', saving: false });
    };
    const onScanCliente = text => {
      const id = parseClienteQR(text);
      const cli = clientes.find(c => c.id === id);
      if (!cli) { setClienteScanOpen(false); flash('⚠️ QR no reconocido como cliente'); return; }
      abrirVentaParaCliente(cli);
    };
    const addProdVenta = p => setVentaRapida(v => {
      const ex = v.items.find(x => x.id === p.id);
      const items = ex ? v.items.map(x => x.id === p.id ? { ...x, cant: x.cant + 1 } : x) : [...v.items, { id: p.id, nombre: p.nombre, cant: 1 }];
      return { ...v, items };
    });
    const updQtyVenta = (id, val) => setVentaRapida(v => ({ ...v, items: val < 1 ? v.items.filter(x => x.id !== id) : v.items.map(x => x.id === id ? { ...x, cant: val } : x) }));

    const guardarVentaRapida = async () => {
      if (!ventaRapida || ventaRapida.items.length === 0) { flash('⚠️ Agrega al menos un producto'); return; }
      setVentaRapida(v => ({ ...v, saving: true }));
      try {
        const faltantes = [];
        ventaRapida.items.forEach(item => {
          const prod = productos.find(x => x.id === item.id);
          if (!prod || prod.stock < item.cant) faltantes.push(`${item.nombre} (disp: ${prod ? prod.stock : 0})`);
        });
        if (faltantes.length > 0) { flash('❌ Sin stock: ' + faltantes.join(', ')); setVentaRapida(v => ({ ...v, saving: false })); return; }

        const itemsConPrecio = ventaRapida.items.map(it => {
          const prod = productos.find(x => x.id === it.id);
          return { id: it.id, nombre: it.nombre, cant: it.cant, precio: prod ? prod.precio : 0 };
        });
        const total = itemsConPrecio.reduce((s, it) => s + it.precio * it.cant, 0);
        const loc = await getLoc();

        const batch = dbx.batch();
        const notaRef = dbx.collection('notas').doc();
        batch.set(notaRef, {
          fecha: new Date().toISOString(), clienteId: ventaRapida.cliente.id, clienteNombre: ventaRapida.cliente.nombre,
          clienteTelefono: ventaRapida.cliente.telefono || '', items: itemsConPrecio, total, formaPago: ventaRapida.pago,
          origen: 'qr_cliente', ...(loc ? { ubicacion: loc } : {}),
        });
        if (ventaRapida.pago === 'credito') {
          batch.set(dbx.collection('creditos').doc(), {
            notaId: notaRef.id, clienteId: ventaRapida.cliente.id, clienteNombre: ventaRapida.cliente.nombre,
            fecha: new Date().toISOString(), total, saldo: total, abonos: [],
          });
        }
        itemsConPrecio.forEach(it => {
          batch.update(dbx.collection('productos').doc(it.id), { stock: firebase.firestore.FieldValue.increment(-it.cant) });
        });
        await batch.commit();
        setVentaRapida(v => ({ ...v, saving: false, done: { total, notaId: notaRef.id, tuvoUbicacion: !!loc, items: itemsConPrecio, pago: v.pago } }));
        flash('✅ Venta guardada — ' + fmtx(total));
      } catch (e) { flash('❌ ' + e.message); setVentaRapida(v => ({ ...v, saving: false })); }
    };

    const iniciarSeguimiento = r => {
      if (!navigator.geolocation) { flash('⚠️ Este dispositivo no soporta GPS'); return; }
      if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current);
      let last = 0;
      watchIdRef.current = navigator.geolocation.watchPosition(p => {
        const now = Date.now();
        if (now - last < 20000) return; // throttle: máx. 1 escritura cada 20s
        last = now;
        dbx.collection('rutas_meta').doc(r.id).update({
          ubicacionActual: { lat: p.coords.latitude, lng: p.coords.longitude, fecha: new Date().toISOString() }
        }).catch(() => {});
      }, () => flash('⚠️ No se pudo obtener ubicación'), { enableHighAccuracy: true });
      setTracking(r.id);
      flash('📍 Compartiendo ubicación en vivo');
    };
    const detenerSeguimiento = () => {
      if (watchIdRef.current) { navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; }
      setTracking(null);
    };
    useEffect(() => () => { if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current); }, []);

    if (!currentUser) return null;

    const activas = rutas.filter(r => r.estado === 'pendiente' || r.estado === 'en_curso');
    const hist = rutas.filter(r => r.estado === 'completada' || r.estado === 'cancelada');
    const misRutas = currentUser.role === 'admin' ? activas : activas.filter(r => r.repartidorId === currentUser.uid);

    return (
      <>
        {!open && (
          <button onClick={() => setOpen(true)} style={{ position: 'fixed', bottom: 84, right: 'max(14px, calc(50vw - 196px))', zIndex: 260, width: 52, height: 52, borderRadius: 26, background: '#38bdf8', border: 'none', color: '#0f172a', fontSize: 22, boxShadow: '0 4px 14px #000a', cursor: 'pointer' }}>🗺️</button>
        )}
        {open && (
          <div style={{ position: 'fixed', inset: 0, background: '#0f172a', zIndex: 280, overflowY: 'auto' }}>
            <div style={{ maxWidth: 420, margin: '0 auto', padding: '16px 12px 90px', color: '#f1f5f9', fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ fontSize: 20, fontWeight: 800 }}>🗺️ Repartidores y rutas</div>
                <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 22, cursor: 'pointer' }}>✕</button>
              </div>
              {msg && <div style={{ background: '#14532d', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#4ade80', marginBottom: 12 }}>{msg}</div>}
              <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                {[['activas', 'Activas'], ['mapa', 'Mapa'], ['clientesqr', 'Clientes'], ['comprobantes', 'Comprob.'], ['historial', 'Historial']].map(([v, l]) => (
                  <button key={v} onClick={() => setTab(v)} style={{ flex: 1, padding: '8px 1px', borderRadius: 8, border: 'none', background: tab === v ? '#38bdf8' : '#1e293b', color: tab === v ? '#0f172a' : '#94a3b8', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>{l}</button>
                ))}
              </div>

              {tab === 'activas' && (
                <>
                  <button onClick={() => setForm({ repartidorId: currentUser.uid, repartidorNombre: currentUser.nombre, vehiculo: '', zona: '', fechaProgramada: '', fechaRegresoProgramada: '', paradas: [] })}
                    style={{ width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 8, padding: 10, fontWeight: 700, marginBottom: 14, cursor: 'pointer' }}>+ Programar ruta</button>
                  {misRutas.length === 0 && <div style={{ textAlign: 'center', color: '#475569', padding: '20px 0' }}>Sin rutas programadas</div>}
                  {misRutas.map(r => (
                    <div key={r.id} style={{ background: '#1e293b', borderRadius: 12, padding: 14, marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{r.repartidorNombre}</span>
                        <span style={{ background: ESTADOS[r.estado].color + '22', color: ESTADOS[r.estado].color, borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 700 }}>{ESTADOS[r.estado].label}</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#94a3b8' }}>🚐 {r.vehiculo || '—'} · 📍 {r.zona || '—'}</div>
                      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>{r.estado === 'pendiente' ? 'Programada: ' + fDateTime(r.fechaProgramada) : 'Salió: ' + fDateTime(r.fechaSalidaReal)}</div>
                      {(r.paradas || []).length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <button onClick={() => setExpandPlan(expandPlan === r.id ? null : r.id)} style={{ background: 'none', border: 'none', color: '#38bdf8', fontSize: 12, cursor: 'pointer', padding: 0, marginBottom: 6 }}>
                            📋 {r.paradas.filter(p => p.visitado).length}/{r.paradas.length} paradas {expandPlan === r.id ? '▲' : '▼'}
                          </button>
                          {expandPlan === r.id && (
                            <div style={{ background: '#0f172a', borderRadius: 8, padding: 10, marginBottom: 6 }}>
                              {r.paradas.map(p => (
                                <div key={p.id} style={{ marginBottom: 10 }}>
                                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                    <button onClick={() => p.visitado ? null : (confirmFor && confirmFor.paradaId === p.id ? setConfirmFor(null) : abrirConfirmacion(r, p))} style={{ background: 'none', border: 'none', color: p.visitado ? '#22c55e' : '#475569', cursor: p.visitado ? 'default' : 'pointer', fontSize: 16, flexShrink: 0, marginTop: 1 }}>{p.visitado ? '✅' : '⬜'}</button>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ fontSize: 12, fontWeight: 700, textDecoration: p.visitado ? 'line-through' : 'none', color: p.visitado ? '#64748b' : '#f1f5f9' }}>{p.clienteNombre}</div>
                                      <div style={{ fontSize: 11, color: '#64748b' }}>{p.items.map(it => `${it.nombre} x${it.cant}`).join(', ')}</div>
                                      {p.visitado && <div style={{ fontSize: 11, color: '#22c55e', marginTop: 2 }}>Entregado · {fmtx(p.totalEntregado)} · {p.formaPago}</div>}
                                    </div>
                                  </div>
                                  {confirmFor && confirmFor.paradaId === p.id && (
                                    <div style={{ background: '#1e293b', borderRadius: 8, padding: 10, marginTop: 6, marginLeft: 24 }}>
                                      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, marginBottom: 6 }}>CONFIRMAR ENTREGA</div>
                                      {confirmItems.map(it => (
                                        <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                          <span style={{ fontSize: 12, flex: 1 }}>{it.nombre}</span>
                                          <button onClick={() => updConfirmQty(it.id, it.cant - 1)} style={{ background: '#334155', border: 'none', color: '#f1f5f9', borderRadius: 6, width: 22, height: 22, cursor: 'pointer' }}>-</button>
                                          <input type="number" min="1" value={it.cant} onChange={e => { const v = e.target.value; if (v === '') return; const n = parseInt(v); if (!isNaN(n) && n >= 1) updConfirmQty(it.id, n); }} onBlur={e => { if (!e.target.value || parseInt(e.target.value) < 1) updConfirmQty(it.id, 1); }} style={{ width: 36, textAlign: 'center', fontSize: 12, background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: '#f1f5f9', padding: '3px 2px' }} />
                                          <button onClick={() => updConfirmQty(it.id, it.cant + 1)} style={{ background: '#334155', border: 'none', color: '#f1f5f9', borderRadius: 6, width: 22, height: 22, cursor: 'pointer' }}>+</button>
                                        </div>
                                      ))}
                                      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                                        {[['contado', '💵 Contado', '#166534', '#4ade80'], ['credito', '📋 Crédito', '#78350f', '#fcd34d']].map(([v, l, bg, col]) => (
                                          <button key={v} onClick={() => setConfirmPago(v)} style={{ flex: 1, padding: 7, borderRadius: 8, border: 'none', background: confirmPago === v ? bg : '#0f172a', color: confirmPago === v ? col : '#94a3b8', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{l}</button>
                                        ))}
                                      </div>
                                      <button onClick={() => confirmarEntrega(r, p)} disabled={confirmSaving} style={{ width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 8, padding: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12, opacity: confirmSaving ? 0.6 : 1 }}>{confirmSaving ? 'Guardando…' : '✓ Confirmar entrega'}</button>
                                    </div>
                                  )}
                                </div>
                              ))}
                              <div style={{ borderTop: '1px solid #334155', paddingTop: 8, marginTop: 4 }}>
                                <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, marginBottom: 3 }}>PARA CARGAR EN TOTAL</div>
                                {totalesParadas(r.paradas).map((it, i) => <div key={i} style={{ fontSize: 11, color: '#94a3b8' }}>• {it.nombre} x{it.cant}</div>)}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {(r.estado === 'pendiente' || r.estado === 'en_curso') && (planEditFor === r.id ? (
                        <div style={{ background: '#0f172a', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                          <ParadaBuilder clientes={clientes} productos={productos} paradas={r.paradas} onChange={ps => actualizarParadas(r.id, ps)} />
                          <button onClick={() => setPlanEditFor(null)} style={{ width: '100%', background: '#1e293b', color: '#94a3b8', border: 'none', borderRadius: 8, padding: 8, fontSize: 12, cursor: 'pointer', marginTop: 4 }}>Listo</button>
                        </div>
                      ) : (
                        <button onClick={() => setPlanEditFor(r.id)} style={{ background: 'transparent', color: '#94a3b8', border: '1px dashed #334155', borderRadius: 8, padding: '6px 10px', fontSize: 11, cursor: 'pointer', marginBottom: 8, width: '100%' }}>+ Agregar cliente al plan</button>
                      ))}
                      <div style={{ display: 'flex', gap: 8 }}>
                        {r.estado === 'pendiente' && <button onClick={() => iniciar(r)} style={{ flex: 1, background: '#166534', color: '#4ade80', border: 'none', borderRadius: 8, padding: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>🚀 Iniciar</button>}
                        {r.estado === 'pendiente' && <button onClick={() => cancelar(r)} style={{ background: 'transparent', color: '#ef4444', border: '1.5px solid #ef4444', borderRadius: 8, padding: '7px 12px', fontSize: 12, cursor: 'pointer' }}>✕</button>}
                        {r.estado === 'en_curso' && <button onClick={() => tracking === r.id ? detenerSeguimiento() : iniciarSeguimiento(r)} style={{ flex: 1, background: tracking === r.id ? '#78350f' : '#0f172a', color: tracking === r.id ? '#fcd34d' : '#94a3b8', border: '1px solid #334155', borderRadius: 8, padding: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>{tracking === r.id ? '📍 Compartiendo…' : '📍 Compartir ubicación'}</button>}
                        {r.estado === 'en_curso' && <button onClick={() => completar(r)} style={{ flex: 1, background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 8, padding: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>🏁 Completar</button>}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {tab === 'mapa' && (
                <div>
                  <div ref={mapRef} style={{ width: '100%', height: 380, borderRadius: 12, background: '#1e293b' }} />
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 8, textAlign: 'center' }}>Muestra las rutas en curso que están compartiendo ubicación en vivo.</div>
                </div>
              )}

              {tab === 'clientesqr' && (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                    <button onClick={() => setClienteScanOpen(true)} style={{ flex: 1, background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 8, padding: 10, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>📷 Escanear para vender</button>
                    <button onClick={() => setClienteBuscarOpen(o => !o)} style={{ flex: 1, background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, padding: 10, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>🔍 Buscar manualmente</button>
                  </div>
                  {clienteBuscarOpen && (
                    <div style={{ marginBottom: 14 }}>
                      <input value={cliQSearch} onChange={e => setCliQSearch(e.target.value)} placeholder="Buscar cliente…" style={inputStyle} />
                      <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                        {clientes.filter(c => c.activo && c.nombre.toLowerCase().includes(cliQSearch.toLowerCase())).map(c => (
                          <div key={c.id} onClick={() => abrirVentaParaCliente(c)} style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, background: '#1e293b', marginBottom: 4 }}>{c.nombre}</div>
                        ))}
                      </div>
                    </div>
                  )}
                  <button onClick={() => setNuevoCliForm(f => f ? null : { nombre: '', telefono: '', domicilio: '' })} style={{ width: '100%', background: 'transparent', color: '#38bdf8', border: '1px dashed #334155', borderRadius: 8, padding: 10, fontWeight: 700, cursor: 'pointer', fontSize: 12, marginBottom: 14 }}>+ Nuevo cliente (genera QR)</button>
                  {nuevoCliForm && (
                    <div style={{ background: '#1e293b', borderRadius: 12, padding: 14, marginBottom: 14 }}>
                      <div style={lblStyle}>Nombre</div>
                      <input value={nuevoCliForm.nombre} onChange={e => setNuevoCliForm(f => ({ ...f, nombre: e.target.value }))} style={inputStyle} />
                      <div style={lblStyle}>Teléfono</div>
                      <input value={nuevoCliForm.telefono} onChange={e => setNuevoCliForm(f => ({ ...f, telefono: e.target.value }))} style={inputStyle} />
                      <div style={lblStyle}>Domicilio</div>
                      <input value={nuevoCliForm.domicilio} onChange={e => setNuevoCliForm(f => ({ ...f, domicilio: e.target.value }))} style={{ ...inputStyle, marginBottom: 12 }} />
                      <button onClick={crearClienteRapido} style={{ width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 8, padding: 10, fontWeight: 700, cursor: 'pointer' }}>💾 Guardar y generar QR</button>
                    </div>
                  )}
                  <input value={cliQSearch} onChange={e => setCliQSearch(e.target.value)} placeholder="🔍 Buscar en la lista…" style={inputStyle} />
                  {clientes.filter(c => c.activo && c.nombre.toLowerCase().includes(cliQSearch.toLowerCase())).map(c => (
                    <div key={c.id} style={{ background: '#1e293b', borderRadius: 12, padding: 12, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{c.nombre}</div>
                        <div style={{ fontSize: 11, color: '#64748b' }}>{c.telefono || '—'}</div>
                      </div>
                      <button onClick={() => verQR(c)} style={{ background: '#172554', color: '#60a5fa', border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>🔲 QR</button>
                    </div>
                  ))}
                </>
              )}

              {tab === 'comprobantes' && (
                <>
                  {rutasReales.length === 0 && <div style={{ textAlign: 'center', color: '#475569', padding: '20px 0' }}>Sin rutas cargadas aún</div>}
                  {rutasReales.map(r => {
                    const { entregas, totalVendido } = resumenRuta(r);
                    return (
                      <div key={r.id} style={{ background: '#1e293b', borderRadius: 12, padding: 14, marginBottom: 10 }}>
                        <button onClick={() => setExpandComp(expandComp === r.id ? null : r.id)} style={{ background: 'none', border: 'none', color: '#f1f5f9', width: '100%', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ fontSize: 12, color: '#94a3b8' }}>{fDateTime(r.fecha)}</span>
                            <span style={{ background: (r.estado === 'activa' ? '#38bdf8' : '#64748b') + '22', color: r.estado === 'activa' ? '#38bdf8' : '#64748b', borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 700 }}>{r.estado === 'activa' ? 'en curso' : 'cerrada'}</span>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{entregas.length} entrega(s) · <span style={{ color: '#38bdf8' }}>{fmtx(totalVendido)}</span></div>
                        </button>
                        {expandComp === r.id && (
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #334155' }}>
                            <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, marginBottom: 4 }}>CARGADO</div>
                            {itemsCargadosDe(r).map((it, i) => <div key={i} style={{ fontSize: 12, color: '#cbd5e1' }}>• {it.nombre} x{it.cant}</div>)}
                            {entregas.length > 0 && <>
                              <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, marginTop: 8, marginBottom: 4 }}>ENTREGAS</div>
                              {entregas.map((e, i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}><span>{e.clienteNombre}</span><span style={{ color: '#38bdf8', fontWeight: 700 }}>{fmtx(e.total)}</span></div>)}
                            </>}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                          <button onClick={() => imprimirGuia(r)} style={{ flex: 1, background: '#0f172a', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, padding: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>🖨️ Imprimir</button>
                          <button onClick={() => { setWaFor(waFor === r.id ? null : r.id); setWaPhone(''); }} style={{ flex: 1, background: '#14532d', color: '#4ade80', border: 'none', borderRadius: 8, padding: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>📲 WhatsApp</button>
                        </div>
                        {waFor === r.id && (
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <input value={waPhone} onChange={e => setWaPhone(e.target.value)} placeholder="Teléfono (10 dígitos)" style={{ ...inputStyle, marginBottom: 0, flex: 1 }} />
                            <button onClick={() => { window.open(waGuiaLink(r, waPhone), '_blank'); setWaFor(null); }} style={{ background: '#25d366', color: '#052e16', border: 'none', borderRadius: 8, padding: '0 14px', fontWeight: 700, cursor: 'pointer' }}>➤</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              {tab === 'historial' && (
                <>
                  {hist.length === 0 && <div style={{ textAlign: 'center', color: '#475569', padding: '20px 0' }}>Sin historial aún</div>}
                  {hist.map(r => {
                    const dur = (r.fechaSalidaReal && r.fechaRegresoReal) ? Math.round((new Date(r.fechaRegresoReal) - new Date(r.fechaSalidaReal)) / 60000) + ' min' : '—';
                    return (
                      <div key={r.id} style={{ background: '#1e293b', borderRadius: 12, padding: 14, marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{r.repartidorNombre}</span>
                          <span style={{ background: ESTADOS[r.estado].color + '22', color: ESTADOS[r.estado].color, borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 700 }}>{ESTADOS[r.estado].label}</span>
                        </div>
                        <div style={{ fontSize: 12, color: '#94a3b8' }}>🚐 {r.vehiculo || '—'} · 📍 {r.zona || '—'} · ⏱ {dur}</div>
                      </div>
                    );
                  })}
                </>
              )}

              {form && (
                <div style={{ position: 'fixed', inset: 0, background: '#000c', zIndex: 300, display: 'flex', alignItems: 'flex-end' }}>
                  <div style={{ background: '#1e293b', width: '100%', maxWidth: 420, margin: '0 auto', borderRadius: '18px 18px 0 0', padding: 20, maxHeight: '85vh', overflowY: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                      <span style={{ fontSize: 16, fontWeight: 700 }}>Programar ruta</span>
                      <button onClick={() => setForm(null)} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 20, cursor: 'pointer' }}>✕</button>
                    </div>
                    {currentUser.role === 'admin' ? (
                      <>
                        <div style={lblStyle}>Repartidor</div>
                        <select value={form.repartidorId} onChange={e => { const u = usuarios.find(x => x.id === e.target.value); setForm(f => ({ ...f, repartidorId: e.target.value, repartidorNombre: u ? u.nombre : '' })); }} style={inputStyle}>
                          {usuarios.map(u => <option key={u.id} value={u.id}>{u.nombre}</option>)}
                        </select>
                      </>
                    ) : (
                      <div style={{ fontSize: 13, marginBottom: 10, color: '#38bdf8' }}>👤 {currentUser.nombre}</div>
                    )}
                    <div style={lblStyle}>Vehículo</div>
                    <input value={form.vehiculo} onChange={e => setForm(f => ({ ...f, vehiculo: e.target.value }))} placeholder="Camioneta blanca, placas…" style={inputStyle} />
                    <div style={lblStyle}>Zona / colonia</div>
                    <input value={form.zona} onChange={e => setForm(f => ({ ...f, zona: e.target.value }))} placeholder="Centro, Col. Reforma…" style={inputStyle} />
                    <div style={lblStyle}>Salida programada</div>
                    <input type="datetime-local" value={form.fechaProgramada} onChange={e => setForm(f => ({ ...f, fechaProgramada: e.target.value }))} style={inputStyle} />
                    <div style={lblStyle}>Regreso estimado (opcional)</div>
                    <input type="datetime-local" value={form.fechaRegresoProgramada} onChange={e => setForm(f => ({ ...f, fechaRegresoProgramada: e.target.value }))} style={inputStyle} />
                    <div style={{ borderTop: '1px solid #334155', margin: '14px 0' }} />
                    <div style={lblStyle}>Clientes y productos por visitar</div>
                    <ParadaBuilder clientes={clientes} productos={productos} paradas={form.paradas} onChange={ps => setForm(f => ({ ...f, paradas: ps }))} />
                    <button onClick={crear} style={{ width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 8, padding: 12, fontWeight: 700, cursor: 'pointer', marginTop: 6 }}>💾 Guardar</button>
                  </div>
                </div>
              )}

              {qrModalFor && (
                <div style={{ position: 'fixed', inset: 0, background: '#000c', zIndex: 310, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ background: '#1e293b', borderRadius: 16, padding: 24, maxWidth: 320, width: '90%', textAlign: 'center' }}>
                    <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>{qrModalFor.nombre}</div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>{qrModalFor.telefono || ''}</div>
                    <div style={{ background: '#fff', borderRadius: 12, padding: 14, minHeight: 260, minWidth: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {qrDataURL ? <img src={qrDataURL} style={{ width: 232, height: 232 }} /> : <span style={{ color: '#94a3b8', fontSize: 12 }}>Generando…</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                      <button onClick={() => imprimirQR(qrModalFor, qrDataURL)} style={{ flex: 1, background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 8, padding: 10, fontWeight: 700, cursor: 'pointer', fontSize: 13 }} disabled={!qrDataURL}>🖨️ Imprimir</button>
                      <button onClick={() => setQrModalFor(null)} style={{ flex: 1, background: '#0f172a', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, padding: 10, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Cerrar</button>
                    </div>
                  </div>
                </div>
              )}

              {clienteScanOpen && <ClienteScanner onDetected={onScanCliente} onClose={() => setClienteScanOpen(false)} />}

              {ventaRapida && (
                <div style={{ position: 'fixed', inset: 0, background: '#000c', zIndex: 310, display: 'flex', alignItems: 'flex-end' }}>
                  <div style={{ background: '#1e293b', width: '100%', maxWidth: 420, margin: '0 auto', borderRadius: '18px 18px 0 0', padding: 20, maxHeight: '88vh', overflowY: 'auto' }}>
                    {!ventaRapida.done ? (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 16, fontWeight: 700 }}>🧾 Venta — {ventaRapida.cliente.nombre}</span>
                          <button onClick={() => setVentaRapida(null)} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 20, cursor: 'pointer' }}>✕</button>
                        </div>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 14 }}>📍 Se guarda con tu ubicación actual, para verificar la visita en campo.</div>
                        <div style={lblStyle}>Agregar productos</div>
                        <input value={ventaProdSearch} onChange={e => setVentaProdSearch(e.target.value)} placeholder="Buscar producto…" style={inputStyle} />
                        <div style={{ maxHeight: 150, overflowY: 'auto', marginBottom: 12 }}>
                          {productos.filter(p => p.nombre.toLowerCase().includes(ventaProdSearch.toLowerCase())).map(p => (
                            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #0f172a' }}>
                              <div><div style={{ fontSize: 12 }}>{p.nombre}</div><div style={{ fontSize: 10, color: '#38bdf8' }}>{fmtx(p.precio)}</div></div>
                              <button onClick={() => addProdVenta(p)} style={{ background: '#172554', color: '#60a5fa', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>+ Agregar</button>
                            </div>
                          ))}
                        </div>
                        {ventaRapida.items.length > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, marginBottom: 6 }}>CARRITO</div>
                            {ventaRapida.items.map(it => (
                              <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                <span style={{ fontSize: 12, flex: 1 }}>{it.nombre}</span>
                                <button onClick={() => updQtyVenta(it.id, it.cant - 1)} style={{ background: '#334155', border: 'none', color: '#f1f5f9', borderRadius: 6, width: 22, height: 22, cursor: 'pointer' }}>-</button>
                                <input type="number" min="1" value={it.cant} onChange={e => { const v = e.target.value; if (v === '') return; const n = parseInt(v); if (!isNaN(n) && n >= 1) updQtyVenta(it.id, n); }} onBlur={e => { if (!e.target.value || parseInt(e.target.value) < 1) updQtyVenta(it.id, 1); }} style={{ width: 36, textAlign: 'center', fontSize: 12, background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: '#f1f5f9', padding: '3px 2px' }} />
                                <button onClick={() => updQtyVenta(it.id, it.cant + 1)} style={{ background: '#334155', border: 'none', color: '#f1f5f9', borderRadius: 6, width: 22, height: 22, cursor: 'pointer' }}>+</button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                          {[['contado', '💵 Contado', '#166534', '#4ade80'], ['credito', '📋 Crédito', '#78350f', '#fcd34d']].map(([v, l, bg, col]) => (
                            <button key={v} onClick={() => setVentaRapida(vv => ({ ...vv, pago: v }))} style={{ flex: 1, padding: 9, borderRadius: 8, border: 'none', background: ventaRapida.pago === v ? bg : '#0f172a', color: ventaRapida.pago === v ? col : '#94a3b8', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{l}</button>
                          ))}
                        </div>
                        <button onClick={guardarVentaRapida} disabled={ventaRapida.saving} style={{ width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 8, padding: 12, fontWeight: 700, cursor: 'pointer', opacity: ventaRapida.saving ? 0.6 : 1 }}>{ventaRapida.saving ? 'Guardando…' : '💾 Guardar venta'}</button>
                      </>
                    ) : (
                      <div style={{ textAlign: 'center', padding: '10px 0' }}>
                        <div style={{ fontSize: 44, marginBottom: 8 }}>✅</div>
                        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Venta guardada</div>
                        <div style={{ color: '#94a3b8', marginBottom: 6 }}>{ventaRapida.cliente.nombre} · {fmtx(ventaRapida.done.total)}</div>
                        <div style={{ fontSize: 11, color: ventaRapida.done.tuvoUbicacion ? '#22c55e' : '#f59e0b', marginBottom: 20 }}>{ventaRapida.done.tuvoUbicacion ? '📍 Ubicación registrada' : '⚠️ No se pudo obtener ubicación'}</div>
                        {ventaRapida.cliente.telefono && <button onClick={() => window.open(waVentaLink(ventaRapida.cliente, ventaRapida.done.items, ventaRapida.done.total, ventaRapida.done.pago), '_blank')} style={{ width: '100%', background: '#25d366', color: '#052e16', border: 'none', borderRadius: 8, padding: 12, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>📲 Enviar ticket por WhatsApp</button>}
                        <button onClick={() => setVentaRapida(null)} style={{ width: '100%', background: '#0f172a', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, padding: 12, fontWeight: 700, cursor: 'pointer' }}>Cerrar</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </>
    );
  }

  function mount() {
    const div = document.createElement('div');
    div.id = 'rutas-repartidores-root';
    document.body.appendChild(div);
    ReactDOM.createRoot(div).render(<RepartidoresPanel />);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
