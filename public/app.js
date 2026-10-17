'use strict';

// La página y el servidor van juntos: server.js tiene la misma versión. Si no coinciden, se avisa arriba.
const VERSION_PAGINA = '2026-10-17.6';
// El programa de la placa que espera esta página (la calibración necesita este o uno más nuevo)
const FIRMWARE_ESPERADO = '2026-10-17.5';
// Zona sugerida para la caja de MDF (en % de la imagen)
const ZONA_SUGERIDA = { x0: 22, x1: 74, y0: 7, y1: 60 };

// Nombres de las clases: llegan del servidor (clases.json)
let NOMBRE_CLASE = { error: 'Sin respuesta de la IA' };
const CANECA = {
  blanca: { titulo: 'Caneca blanca', nota: 'Aprovechables' },
  verde: { titulo: 'Caneca verde', nota: 'Orgánicos aprovechables' },
  negra: { titulo: 'Caneca negra', nota: 'No aprovechables' },
  especial: { titulo: 'Residuos especiales', nota: 'Mejor llevarlos a un punto de recolección' },
  ninguna: { titulo: 'Bandeja vacía', nota: 'La bandeja no se mueve' },
};
// Ángulos fijos de la placa (calibrados en la caja)
const ANGULO = { aprovechables: 150, no_aprovechables: 30 };
const NOMBRE_ORIGEN = {
  auto: 'Automático (ultrasónico o cámara)',
  boton: 'Botón Clasificar de la caneca',
  monitor: 'Desde el monitor',
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const coma = (n, dec = 1) => Number(n).toFixed(dec).replace('.', ',');
const limitar = (v, min, max) => Math.min(max, Math.max(min, v));
const LADOS_ZONA = ['x0', 'x1', 'y0', 'y1'];

const app = {
  servidor: false,
  online: false,
  versionServidor: null,
  estado: null,
  conteos: {},
  eventos: [],
  umbralCamara: null,
  zona: null,
  // Quién maneja: 'mirando' (solo ver), 'espera' (en la fila, con PIN) o 'tuyo' (tienes el control)
  control: { estado: 'mirando', puesto: 0, ocupado: false, enFila: 0, mirando: 0 },
  lados: { blanca: 'aprovechables', verde: 'no_aprovechables', negra: 'no_aprovechables', especial: 'no_aprovechables', ninguna: 'nivel' },
  clases: [],
  estadisticas: { ultimas24h: [], tiempoIA: null },
  capturas: [],
  tiposCaptura: {},
  ultimaImagen: 0,
  imagenesSegundo: 0,
  urlImagen: null,
};

const manejo = () => app.control.estado === 'tuyo';

let ws = null;
let esperaReconexion = 1000;

// ---------------------------------------------------------------------------
// Conexión con el servidor
// ---------------------------------------------------------------------------
function conectar() {
  const protocolo = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocolo}://${location.host}/ws/monitor`);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    esperaReconexion = 1000;
    app.servidor = true;
    pintarConexion();
    // Si tenías el control y se cayó la conexión (o recargaste), lo vuelve a pedir con el mismo PIN
    const pin = leerSesion('pin-caneca');
    if (pin && leerSesion('control-caneca') === '1') mandar({ t: 'pedirControl', pin });
    depurarEnviado = false;
    actualizarDepurar();
  });

  ws.addEventListener('close', () => {
    app.servidor = false;
    app.online = false;
    pintarConexion();
    setTimeout(conectar, esperaReconexion);
    esperaReconexion = Math.min(esperaReconexion * 2, 15000);
  });

  ws.addEventListener('message', (evento) => {
    if (typeof evento.data !== 'string') {
      const bytes = new Uint8Array(evento.data);
      if (bytes[0] === 0x44) recibirCuadro(bytes); // 'D': miniaturas de la calibración
      else mostrarImagen(evento.data); // JPEG en vivo
      return;
    }
    let mensaje;
    try {
      mensaje = JSON.parse(evento.data);
    } catch {
      return;
    }
    manejar(mensaje);
  });
}

function manejar(m) {
  switch (m.t) {
    case 'resumen': {
      app.versionServidor = m.version || null;
      app.online = m.online;
      app.estado = m.estado;
      app.conteos = m.conteos || {};
      app.eventos = m.eventos || [];
      app.capturas = m.capturas || [];
      app.tiposCaptura = m.tiposCaptura || app.tiposCaptura;
      if (m.lados) app.lados = m.lados;
      if (m.estadisticas) app.estadisticas = m.estadisticas;
      if (m.clases) {
        app.clases = m.clases;
        NOMBRE_CLASE = { error: 'Sin respuesta de la IA', ...Object.fromEntries(m.clases.map((c) => [c.id, c.nombre])) };
      }
      recibirAjustes(m.umbralCamara ?? app.umbralCamara, m.zona || app.zona);
      pintarTodo();
      break;
    }
    case 'online':
      app.online = m.valor;
      pintarConexion();
      pintarControl();
      break;
    case 'estado':
      app.estado = m.estado;
      pintarEstado();
      break;
    case 'evento':
      app.eventos = [m.evento, ...app.eventos].slice(0, 30);
      app.conteos = m.conteos || app.conteos;
      if (m.estadisticas) app.estadisticas = m.estadisticas;
      pintarConteos();
      pintarHistorial();
      pintarUltima();
      break;
    case 'ajustes':
      recibirAjustes(m.umbralCamara, m.zona);
      cal.historia = []; // los % cambian con la zona nueva
      pintarEstado();
      pintarCal();
      break;
    case 'control':
      app.control = m;
      // recordar si manejabas o esperabas, para volver a pedirlo si se cae la conexión
      guardarSesion('control-caneca', m.estado === 'mirando' ? null : '1');
      pintarControl();
      pintarConexion();
      break;
    case 'depuracion':
      recibirNumeros(m);
      break;
    case 'capturas':
      app.capturas = m.lista || [];
      pintarCapturas();
      break;
    case 'ok':
      avisar(m.msg, 'ok');
      break;
    case 'error':
      avisar(m.msg, 'error');
      if (/PIN/i.test(m.msg || '')) marcarPinMalo();
      break;
    default:
      break;
  }
}

function mandar(mensaje) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    avisar('No hay conexión con el servidor. Espera a que vuelva (arriba dice cuándo).', 'error');
    return false;
  }
  ws.send(JSON.stringify(mensaje));
  return true;
}

// sessionStorage puede fallar (ventana privada, previsualización): sin él solo no se recuerda el PIN
function leerSesion(clave) {
  try {
    return sessionStorage.getItem(clave);
  } catch {
    return null;
  }
}
function guardarSesion(clave, valor) {
  try {
    if (valor === null) sessionStorage.removeItem(clave);
    else sessionStorage.setItem(clave, valor);
  } catch {
    /* sin almacenamiento */
  }
}

// ---------------------------------------------------------------------------
// Pestañas
// ---------------------------------------------------------------------------
const PANELES = ['vivo', 'calibrar', 'analisis', 'historial'];
let panelActual = 'vivo';

function mostrarPanel(nombre, { enfocar = false, subir = true } = {}) {
  if (!PANELES.includes(nombre)) nombre = 'vivo';
  const cambio = nombre !== panelActual;
  panelActual = nombre;
  for (const p of PANELES) {
    const activo = p === nombre;
    const tab = $(`#tab-${p}`);
    tab.setAttribute('aria-selected', String(activo));
    tab.tabIndex = activo ? 0 : -1;
    $(`#panel-${p}`).hidden = !activo;
  }
  if (enfocar) $(`#tab-${nombre}`).focus();
  if (location.hash !== `#${nombre}`) history.replaceState(null, '', `#${nombre}`);
  if (nombre === 'calibrar') {
    if (cambio) dep.pedidoDesde = Date.now();
    pintarCal();
  }
  if (nombre === 'analisis') pintarActividad();
  actualizarDepurar();
  if (cambio && subir) window.scrollTo(0, 0);
}

$('#pestanas').addEventListener('click', (ev) => {
  const tab = ev.target.closest('[role="tab"]');
  if (tab) mostrarPanel(tab.dataset.panel);
});

$('#pestanas').addEventListener('keydown', (ev) => {
  const i = PANELES.indexOf(panelActual);
  let j = null;
  if (ev.key === 'ArrowRight') j = (i + 1) % PANELES.length;
  else if (ev.key === 'ArrowLeft') j = (i - 1 + PANELES.length) % PANELES.length;
  else if (ev.key === 'Home') j = 0;
  else if (ev.key === 'End') j = PANELES.length - 1;
  if (j === null) return;
  ev.preventDefault();
  mostrarPanel(PANELES[j], { enfocar: true });
});

window.addEventListener('hashchange', () => mostrarPanel(location.hash.slice(1)));

// La caneca solo manda las imágenes de calibración mientras alguien tiene abierta esa pestaña
let depurarEnviado = false;
function actualizarDepurar() {
  const activo = panelActual === 'calibrar' && document.visibilityState === 'visible';
  if (activo === depurarEnviado || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t: 'depurar', activo }));
  depurarEnviado = activo;
  if (activo) dep.pedidoDesde = Date.now();
}
document.addEventListener('visibilitychange', actualizarDepurar);

// ---------------------------------------------------------------------------
// Imagen en vivo
// ---------------------------------------------------------------------------
function mostrarImagen(buffer) {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
  const anterior = app.urlImagen;
  const img = $('#camara-img');
  img.onload = () => {
    if (anterior) URL.revokeObjectURL(anterior);
  };
  img.src = url;
  app.urlImagen = url;
  app.ultimaImagen = Date.now();
  app.imagenesSegundo += 1;
  $('#camara').dataset.estado = 'vivo';
}

setInterval(() => {
  const vivo = Date.now() - app.ultimaImagen < 3000;
  $('#camara').dataset.estado = vivo ? 'vivo' : 'sin-imagen';
  $('#en-vivo').textContent = vivo && app.imagenesSegundo > 0 ? `En vivo, ${app.imagenesSegundo} img/s` : 'En vivo';
  app.imagenesSegundo = 0;
  if (!vivo) {
    $('#camara-vacia').textContent = !app.servidor
      ? 'Sin conexión con el servidor'
      : app.online
        ? 'Esperando imagen de la cámara'
        : 'La caneca no está conectada. Revisa que esté prendida y con Wi-Fi.';
  }
  if (panelActual === 'calibrar') pintarEstadoCal();
}, 1000);

// ---------------------------------------------------------------------------
// Pintar la página
// ---------------------------------------------------------------------------
function pintarTodo() {
  pintarVersion();
  pintarConexion();
  pintarControl();
  pintarLados();
  pintarEstado();
  pintarConteos();
  pintarHistorial();
  pintarUltima();
  pintarCal();
  pintarCapturas();
}

// Página y servidor de versiones distintas = casi siempre un servidor viejo que sigue prendido
function pintarVersion() {
  const aviso = $('#aviso-version');
  const igual = app.versionServidor === VERSION_PAGINA;
  aviso.hidden = !app.servidor || igual;
  aviso.textContent = igual
    ? ''
    : `El servidor tiene otra versión (${app.versionServidor || 'vieja'}) que esta página (${VERSION_PAGINA}), y por eso algunos botones pueden fallar. ` +
      'Si el servidor está en tu computador: ciérralo con Ctrl+C, ábrelo otra vez con npm start y recarga esta página. Si está en el hosting, espera un minuto a que termine de desplegar y recarga.';
}

// Comparar versiones tipo 2026-10-17.5 (número por número)
function compararVersion(a, b) {
  const pa = String(a).split(/[-.]/).map(Number);
  const pb = String(b).split(/[-.]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
const firmwareViejo = () => !app.estado?.fw || compararVersion(app.estado.fw, FIRMWARE_ESPERADO) < 0;

// Por qué no se pueden usar los botones (o null si sí se puede)
function motivoBloqueo({ necesitaCaneca = true } = {}) {
  if (!app.servidor) return 'Sin conexión con el servidor: los botones vuelven solos cuando se conecte.';
  if (app.control.estado === 'espera') return 'Estás en la fila: los botones se activan cuando sea tu turno.';
  if (!manejo()) {
    return app.control.ocupado
      ? 'Otra persona está manejando la caneca. Puedes mirar, o escribir el PIN arriba para ponerte en la fila.'
      : 'Estás mirando. Para usar los botones, escribe el PIN arriba y toca Tomar el control.';
  }
  if (necesitaCaneca && !app.online) return 'La caneca no está conectada: los botones se activan solos cuando se conecte.';
  return null;
}

function pintarConexion() {
  const caja = $('#conexion');
  let texto;
  if (!app.servidor) {
    caja.dataset.estado = 'conectando';
    texto = 'Conectando con el servidor…';
  } else if (app.online) {
    caja.dataset.estado = 'online';
    texto = 'Caneca conectada';
  } else {
    caja.dataset.estado = 'offline';
    texto = 'Caneca sin conexión';
  }
  $('#conexion-texto').textContent = texto;
  // Los botones solo funcionan para quien tiene el control (y con la caneca conectada)
  for (const boton of $$('[data-orden]')) boton.disabled = !app.online || !manejo();
  for (const boton of $$('.dep-captura')) boton.disabled = !manejo();
  $('#btn-reiniciar').disabled = !manejo();
  $('#control').hidden = !app.servidor;

  const motivo = motivoBloqueo();
  $('#bloqueo').hidden = !motivo;
  $('#bloqueo').textContent = motivo || '';
  const motivoFallas = motivoBloqueo({ necesitaCaneca: false });
  $('#fallas-bloqueo').hidden = !motivoFallas;
  $('#fallas-bloqueo').textContent = motivoFallas ? motivoFallas.replace('los botones', 'estos botones') : '';
  pintarGuardar();
}

function pintarControl() {
  const c = app.control;
  const caja = $('#control');
  caja.dataset.estado = c.estado;
  // cuántas personas (aparte de ti) solo miran: ni manejan ni están en la fila
  const soloMiran = Math.max(0, c.mirando - (c.ocupado ? 1 : 0) - c.enFila - (c.estado === 'mirando' ? 1 : 0));
  const otros = soloMiran ? ` ${soloMiran} ${soloMiran === 1 ? 'persona más está mirando' : 'personas más están mirando'}.` : '';
  let titulo;
  let texto;
  if (c.estado === 'tuyo') {
    titulo = 'Tienes el control';
    texto = (c.enFila ? `${c.enFila} ${c.enFila === 1 ? 'persona espera' : 'personas esperan'} su turno. ` : 'Los demás solo pueden mirar. ') +
      'Cuando termines, deja el control.' + otros;
    if (!app.online) texto = 'La caneca no está conectada: los botones se activan solos cuando se conecte. ' + texto;
  } else if (c.estado === 'espera') {
    titulo = `Estás en la fila, puesto ${c.puesto}`;
    texto = 'Otra persona está manejando la caneca. Cuando termine, el control pasa a ti solo: deja esta página abierta.' + otros;
  } else if (c.ocupado) {
    titulo = 'Otra persona está manejando la caneca';
    texto = 'Puedes mirar todo. Si escribes el PIN quedas en la fila' + (c.enFila ? ` (hay ${c.enFila} esperando)` : '') + '.' + otros;
  } else {
    titulo = 'Estás mirando';
    texto = 'Nadie está manejando la caneca. Escribe el PIN para tomar el control.' + otros;
  }
  $('#control-titulo').textContent = titulo;
  $('#control-texto').textContent = texto;
  $('#form-control').hidden = c.estado !== 'mirando';
  $('#btn-control').textContent = c.ocupado ? 'Ponerme en la fila' : 'Tomar el control';
  const soltar = $('#btn-soltar');
  soltar.hidden = c.estado === 'mirando';
  soltar.textContent = c.estado === 'tuyo' ? 'Terminar y dejar el control' : 'Salir de la fila';
}

function marcarPinMalo() {
  const caja = $('.pin');
  caja.dataset.error = 'si';
  $('#pin').select();
  setTimeout(() => delete caja.dataset.error, 1200);
}

function irAlPin() {
  $('#control').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('#pin').focus({ preventScroll: true }), 300);
}

// Los dos botones grandes: cada lado se llama por su caneca
const LADO_UI = {
  aprovechables: { boton: '#btn-si', destino: '#destino-si', porDefecto: 'blanca' },
  no_aprovechables: { boton: '#btn-no', destino: '#destino-no', porDefecto: 'negra' },
};

function pintarLados() {
  for (const [lado, ui] of Object.entries(LADO_UI)) {
    const canecas = Object.keys(app.lados).filter((k) => app.lados[k] === lado);
    const boton = $(ui.boton);
    const tipo = canecas.includes('blanca') ? 'blanca' : canecas.includes('negra') ? 'negra' : canecas.includes('verde') ? 'verde' : ui.porDefecto;
    for (const t of ['blanca', 'verde', 'negra']) boton.classList.toggle(`lado-${t}`, t === tipo);
    let texto = 'Sin caneca asignada';
    if (canecas.includes('verde') && canecas.includes('negra')) texto = 'Caneca negra y verde';
    else if (canecas.length) texto = canecas.map((k) => CANECA[k].titulo).join(' y ');
    $(ui.destino).textContent = `${texto}, ${ANGULO[lado]}°`;
  }
}

const NOMBRE_VACIAR = { aprovechables: 'aprovechables', no_aprovechables: 'no aprovechables' };

function textoDeteccion(e) {
  if (e.atascado) return ['El residuo no cayó', 'Sácalo a mano o toca Nivelar.'];
  if (e.vaciar) return ['Modo vaciar', `La bandeja está de canto hacia ${NOMBRE_VACIAR[e.vaciarLado] || 'un lado'}. Toca Nivelar al terminar.`];
  if (e.pausa) return ['En pausa', 'No clasifica sola. Toca Reanudar.'];
  if (e.esperando && (e.ultra || e.cam)) return ['Ya se clasificó', 'Espera a que la bandeja quede libre.'];
  if (e.ultra && e.cam) return ['Hay un residuo', 'Lo ven el ultrasónico y la cámara.'];
  if (e.ultra) return ['Hay un residuo', 'Lo ve el ultrasónico (la cámara no).'];
  if (e.cam) return ['Hay un residuo', 'Lo ve la cámara (el ultrasónico no).'];
  return ['Bandeja libre', 'Ni el ultrasónico ni la cámara ven algo.'];
}

function pintarMedidor(relleno, raya, valor, umbral, escala) {
  $(relleno).style.width = `${limitar(valor / escala, 0, 1) * 100}%`;
  $(raya).style.left = `${limitar(umbral / escala, 0, 1) * 100}%`;
}

function pintarEstado() {
  const e = app.estado;
  if (!e) return;
  // Ultrasónico: cuánto más cerca que la bandeja vacía
  const umbralCm = e.ultraUmbral ?? 1.5;
  $('#s-ultra').dataset.ve = e.ultra ? 'si' : 'no';
  if (e.dist === null || e.dist === undefined) {
    $('#s-dist').textContent = '—';
    $('#s-dist-sub').textContent = 'Sin medida: revisa los cables del sensor.';
    pintarMedidor('#m-ultra', '#m-ultra-raya', 0, umbralCm, umbralCm * 3);
  } else if (!e.vacia) {
    $('#s-dist').textContent = `${coma(e.dist)} cm`;
    $('#s-dist-sub').textContent = 'Midiendo la bandeja vacía…';
    pintarMedidor('#m-ultra', '#m-ultra-raya', 0, umbralCm, umbralCm * 3);
  } else {
    const dif = e.vacia - e.dist;
    $('#s-dist').textContent = `${coma(e.dist)} cm`;
    $('#s-dist-sub').textContent = dif >= 0
      ? `${coma(dif)} cm más cerca que la bandeja vacía (${coma(e.vacia)} cm). Hay residuo desde ${coma(umbralCm)} cm.`
      : `${coma(-dif)} cm más lejos que la bandeja vacía (${coma(e.vacia)} cm).${dif < -2 ? ' Revisa que la bandeja esté a nivel y el sensor derecho.' : ''}`;
    pintarMedidor('#m-ultra', '#m-ultra-raya', dif, umbralCm, Math.max(5, umbralCm * 3));
  }
  // Cámara
  const umbralCam = app.umbralCamara ?? 3;
  $('#s-cam').dataset.ve = e.cam ? 'si' : 'no';
  if (e.camPct === null || e.camPct === undefined) {
    $('#s-campct').textContent = '—';
    $('#s-cam-sub').textContent = 'Guardando la foto de la bandeja vacía…';
    pintarMedidor('#m-cam', '#m-cam-raya', 0, umbralCam, umbralCam * 3);
  } else {
    $('#s-campct').textContent = `${e.camPct} %`;
    $('#s-cam-sub').textContent = `de la zona cambió frente a la bandeja vacía. Hay residuo desde ${umbralCam} %.`;
    pintarMedidor('#m-cam', '#m-cam-raya', e.camPct, umbralCam, Math.max(10, umbralCam * 3));
  }
  // Detección y bandeja
  const [det, detSub] = textoDeteccion(e);
  $('#s-detec').textContent = det;
  $('#s-detec-sub').textContent = detSub;
  $('#s-det').dataset.ve = e.atascado ? 'alerta' : e.ultra || e.cam ? 'si' : 'no';
  $('#s-servo').textContent = `${e.servo}°`;
  $('#s-modo').textContent = e.servo === 90 ? 'A nivel' : e.servo >= 140 ? 'Inclinada hacia aprovechables' : e.servo <= 40 ? 'Inclinada hacia no aprovechables' : 'Moviéndose';
  $('#s-bandeja').style.transform = `rotate(${limitar((e.servo || 90) - 90, -65, 65)}deg)`;

  const calidad = e.rssi === null || e.rssi === undefined ? '' : e.rssi > -60 ? ' (buena)' : e.rssi > -72 ? ' (regular)' : ' (débil)';
  $('#s-pie').textContent =
    `Wi-Fi: ${e.rssi === null || e.rssi === undefined ? 'sin datos' : `${e.rssi} dBm${calidad}`}.` + (e.fw ? ` Programa de la caneca: ${e.fw}.` : '');
  const avisoFw = $('#aviso-fw');
  const fwViejo = app.online && firmwareViejo();
  avisoFw.hidden = !fwViejo;
  avisoFw.textContent = fwViejo
    ? `La caneca tiene un programa más viejo (${e.fw || 'sin versión'}) que el que espera esta página (${FIRMWARE_ESPERADO}). Vuelve a cargarle el programa de la carpeta Caneca3 para que la calibración funcione.`
    : '';

  // La página de la caneca (Wi-Fi) también se abre desde la misma red, por su IP
  const pagina = $('#e-pagina');
  pagina.replaceChildren('Página de la caneca: ');
  if (e.ip) {
    const enlace = document.createElement('a');
    enlace.href = `http://${e.ip}/`;
    enlace.target = '_blank';
    enlace.rel = 'noopener';
    enlace.textContent = `http://${e.ip}`;
    pagina.append(enlace, ' desde tu misma red Wi-Fi, o http://192.168.4.1 conectado a la red Caneca-IoT.');
  } else {
    pagina.append('http://192.168.4.1 conectado a la red Caneca-IoT.');
  }

  $('#btn-pausa').textContent = e.pausa ? 'Reanudar' : 'Pausar';
  $('#btn-pausa').title = e.pausa ? 'Vuelve a clasificar sola' : 'Deja de clasificar sola (los botones siguen funcionando)';
  $('#btn-flash').setAttribute('aria-pressed', String(Boolean(e.flash)));
  $('#btn-flash').textContent = e.flash ? 'Flash prendido' : 'Flash';
}

// ---------------------------------------------------------------------------
// Análisis
// ---------------------------------------------------------------------------
const fmt = new Intl.NumberFormat('es-CO');
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
const esAprovechable = (clase) => app.clases.find((c) => c.id === clase)?.caneca === 'blanca';
const cuenta = (clase) => app.conteos[clase] ?? 0;

function filaBarra(nombre, n, max, totalGrupo) {
  const li = document.createElement('li');
  if (!n) li.className = 'cero';
  const nom = document.createElement('span');
  nom.className = 'nombre';
  nom.textContent = nombre;
  const pista = document.createElement('span');
  pista.className = 'pista';
  const relleno = document.createElement('span');
  relleno.className = 'relleno';
  relleno.style.width = `${max ? (n / max) * 100 : 0}%`;
  pista.append(relleno);
  const numero = document.createElement('span');
  numero.className = 'num';
  numero.textContent = fmt.format(n);
  const p = document.createElement('span');
  p.className = 'pct';
  p.textContent = totalGrupo ? `${pct(n, totalGrupo)}%` : '';
  li.title = `${nombre}: ${fmt.format(n)} (${pct(n, totalGrupo)}% del grupo)`;
  li.append(nom, pista, numero, p);
  return li;
}

function pintarBarras(lista, clases, mostrarCeros) {
  const datos = clases.map((c) => ({ nombre: c.nombre, n: cuenta(c.id) })).sort((x, y) => y.n - x.n);
  const total = datos.reduce((a, d) => a + d.n, 0);
  const max = Math.max(0, ...datos.map((d) => d.n));
  lista.replaceChildren();
  const visibles = mostrarCeros ? datos : datos.filter((d) => d.n > 0);
  if (!visibles.length) {
    const p = document.createElement('p');
    p.className = 'vacio-nota';
    p.textContent = 'Aún no ha caído nada de este grupo.';
    lista.append(p);
    return;
  }
  for (const d of visibles) lista.append(filaBarra(d.nombre, d.n, max, total));
}

function pintarActividad() {
  const cols = $('#columnas');
  const eje = $('#columnas-eje');
  const horaActual = new Date();
  horaActual.setMinutes(0, 0, 0);
  const inicio = horaActual.getTime() - 23 * 3600 * 1000;
  const cubos = Array.from({ length: 24 }, (_, i) => ({ t: inicio + i * 3600 * 1000, si: 0, no: 0 }));
  for (const [t, clase] of app.estadisticas.ultimas24h || []) {
    const i = Math.floor((t - inicio) / 3600000);
    if (i < 0 || i > 23 || clase === 'vacio') continue;
    if (esAprovechable(clase)) cubos[i].si++;
    else cubos[i].no++;
  }
  const max = Math.max(1, ...cubos.map((c) => c.si + c.no));
  cols.replaceChildren();
  eje.replaceChildren();
  cubos.forEach((c, i) => {
    const col = document.createElement('div');
    col.className = 'columna';
    const h = new Date(c.t).getHours();
    col.title = `${String(h).padStart(2, '0')}:00, ${c.si} aprovechables y ${c.no} no aprovechables`;
    for (const [clave, n] of [['si', c.si], ['no', c.no]]) {
      if (!n) continue;
      const parte = document.createElement('span');
      parte.className = `parte parte-${clave}`;
      parte.style.height = `${(n / max) * 100}%`;
      col.append(parte);
    }
    cols.append(col);
    const etq = document.createElement('span');
    etq.textContent = i % 3 === 2 || i === 23 ? `${h}h` : '';
    eje.append(etq);
  });
}

function pintarConteos() {
  const aprovechables = app.clases.filter((c) => c.caneca === 'blanca');
  const noAprovechables = app.clases.filter((c) => c.caneca !== 'blanca' && c.caneca !== 'ninguna');
  const si = aprovechables.reduce((a, c) => a + cuenta(c.id), 0);
  const no = noAprovechables.reduce((a, c) => a + cuenta(c.id), 0);
  const total = si + no;

  $('#tasa-pct').textContent = total ? `${pct(si, total)} %` : '—';
  $('#tasa-sub').textContent = total
    ? `${fmt.format(si)} de ${fmt.format(total)} residuos clasificados fueron a aprovechables.`
    : 'Todavía no hay residuos clasificados. Cuando la caneca clasifique, aquí se ve cuánto se puede reciclar.';
  $('#seg-si').style.width = `${total ? (si / total) * 100 : 0}%`;
  $('#seg-no').style.width = `${total ? (no / total) * 100 : 0}%`;
  $('#tasa-barra').setAttribute('aria-label', `${pct(si, total)}% aprovechables, ${pct(no, total)}% no aprovechables`);
  $('#n-si').textContent = `${fmt.format(si)} (${pct(si, total)}%)`;
  $('#n-no').textContent = `${fmt.format(no)} (${pct(no, total)}%)`;

  const ult = (app.estadisticas.ultimas24h || []).filter(([, c]) => c !== 'vacio');
  const haceHora = Date.now() - 3600 * 1000;
  $('#k-total').textContent = fmt.format(total);
  $('#k-24h').textContent = fmt.format(ult.length);
  $('#k-hora').textContent = fmt.format(ult.filter(([t]) => t >= haceHora).length);
  $('#k-ia').textContent = app.estadisticas.tiempoIA ? `${coma(app.estadisticas.tiempoIA / 1000)} s` : '—';

  pintarBarras($('#barras-si'), aprovechables, true);
  pintarBarras($('#barras-no'), noAprovechables, false);
  pintarActividad();
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
function hora(iso) {
  const fecha = new Date(iso);
  const hhmm = fecha.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  if (fecha.toDateString() === new Date().toDateString()) return hhmm;
  return `${fecha.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}, ${hhmm}`;
}

function textoLado(lado) {
  if (lado === 'aprovechables') return 'fue a aprovechables';
  if (lado === 'no_aprovechables') return 'fue a no aprovechables';
  if (lado === 'izquierda' || lado === 'derecha') return `fue a la ${lado}`; // eventos viejos
  return 'se quedó en la bandeja';
}

const QUE_HACER = {
  negra: 'va a la caneca negra: retíralo a mano',
  especial: 'residuo especial: llévalo a un punto de recolección',
};

function describir(evento) {
  if (evento.tipo === 'aviso') return `Aviso: ${evento.msg}`;
  if (evento.tipo === 'captura') {
    const tipo = app.tiposCaptura[evento.capturaTipo] || 'Captura';
    return `Captura guardada: ${tipo}${evento.nota ? ` («${evento.nota}»)` : ''}`;
  }
  if (evento.tipo === 'clasificacion') {
    const accion = evento.lado === 'nivel' && QUE_HACER[evento.caneca] ? QUE_HACER[evento.caneca] : textoLado(evento.lado);
    return `${NOMBRE_CLASE[evento.clase] || evento.clase}, ${accion}`;
  }
  if (evento.lado === 'nivel') return 'Bandeja nivelada';
  if (evento.lado === 'vaciar_aprovechables') return 'Bandeja de canto para vaciar aprovechables';
  if (evento.lado === 'vaciar_no_aprovechables' || evento.lado === 'vaciar') return 'Bandeja de canto para vaciar no aprovechables';
  return `Bandeja inclinada: ${textoLado(evento.lado).replace('fue ', '')}`;
}

function tipoEvento(evento) {
  if (evento.tipo === 'clasificacion') {
    if (evento.clase === 'vacio' || evento.lado === 'nivel') return 'vacio';
    return evento.lado === 'aprovechables' ? 'si' : 'no';
  }
  return evento.tipo === 'aviso' ? 'aviso' : evento.tipo === 'captura' ? 'captura' : 'mov';
}

function miniatura(src, texto) {
  const boton = document.createElement('button');
  boton.type = 'button';
  boton.className = 'miniatura';
  boton.setAttribute('aria-label', `Ver la foto: ${texto}`);
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => boton.remove());
  boton.append(img);
  boton.addEventListener('click', () => abrirVisor(src, texto));
  return boton;
}

function pintarHistorial() {
  const lista = $('#historial');
  lista.replaceChildren();
  for (const evento of app.eventos) {
    const fila = document.createElement('li');
    fila.dataset.tipo = tipoEvento(evento);

    const cuando = document.createElement('time');
    cuando.dateTime = evento.fecha;
    cuando.textContent = hora(evento.fecha);

    const que = document.createElement('div');
    que.className = 'historial-que';
    const titulo = document.createElement('strong');
    titulo.textContent = describir(evento);
    const detalle = document.createElement('small');
    const partes = [NOMBRE_ORIGEN[evento.origen], evento.ms ? `la IA tardó ${coma(evento.ms / 1000)} s` : null].filter(Boolean);
    detalle.textContent = partes.join(', ');
    que.append(titulo);
    if (partes.length) que.append(detalle);
    if (evento.nota && evento.tipo === 'clasificacion') que.title = evento.nota;

    fila.append(cuando, que);
    // la foto que vio la IA, o la captura de calibración, para revisarla
    if (evento.tipo === 'clasificacion' && evento.foto) {
      fila.append(miniatura(`/fotos/${evento.id}.jpg`, `${describir(evento)}, ${hora(evento.fecha)}`));
    } else if (evento.tipo === 'captura' && evento.capturaId) {
      const revisar = document.createElement('button');
      revisar.type = 'button';
      revisar.className = 'boton-texto';
      revisar.textContent = 'Revisar';
      revisar.addEventListener('click', () => abrirCaptura(evento.capturaId));
      fila.append(revisar);
    } else {
      fila.append(document.createElement('span'));
    }
    lista.append(fila);
  }
  $('#historial-vacio').hidden = app.eventos.length > 0;
}

function pintarUltima() {
  const ultima = app.eventos.find((e) => e.tipo === 'clasificacion');
  const foto = $('#ultima-foto');
  if (!ultima) {
    $('#ultima-texto').textContent = 'Todavía no hay clasificaciones.';
    foto.hidden = true;
    return;
  }
  const texto = `${describir(ultima)}, ${hora(ultima.fecha)}`;
  $('#ultima-texto').textContent = texto;
  const src = ultima.foto ? `/fotos/${ultima.id}.jpg` : `/ultima.jpg?v=${ultima.id}`;
  $('#ultima-img').src = src;
  foto.onclick = () => abrirVisor(src, texto);
  foto.hidden = false;
}

function abrirVisor(src, texto) {
  const visor = $('#visor');
  $('#visor-img').src = src;
  $('#visor-img').alt = texto;
  $('#visor-texto').textContent = texto;
  if (typeof visor.showModal === 'function') visor.showModal();
  else window.open(src, '_blank', 'noopener');
}
$('#visor').addEventListener('click', (ev) => {
  if (ev.target === $('#visor')) $('#visor').close(); // tocar fuera de la foto la cierra
});

let temporizadorAviso = null;
function avisar(texto, tipo) {
  const aviso = $('#aviso');
  aviso.textContent = texto;
  aviso.dataset.tipo = tipo;
  aviso.dataset.visible = 'si';
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => {
    aviso.dataset.visible = 'no';
  }, tipo === 'error' ? 7000 : 4000);
}

// ---------------------------------------------------------------------------
// Calibrar
// La placa manda (solo mientras la pestaña está abierta) tres miniaturas de 80 x 60 en gris:
// la bandeja vacía que tiene guardada, lo que ve ahora y qué puntos cambiaron.
// Los ajustes que mueves aquí son un borrador: se ven al instante y la caneca los usa al guardar.
// ---------------------------------------------------------------------------
const dep = {
  congelado: false,
  viendoCaptura: null, // id de la captura que se está revisando (null = en vivo)
  numeros: null,
  cuadro: null,
  capas: null, // las tres imágenes ya pintadas (80 x 60)
  vista: 'dif',
  foto: null, // foto en color de una captura
  ultimoCuadro: 0,
  pedidoDesde: 0,
};

const cal = {
  umbral: null, // lo que estás probando (sin guardar)
  zona: null,
  historia: [], // [fecha, % de la cámara] de los últimos 30 s, para ver hasta dónde sube
  editarZona: false,
  arrastre: null,
};

const mismaZona = (a, b) => Boolean(a && b) && LADOS_ZONA.every((k) => a[k] === b[k]);
function hayCambios() {
  if (cal.umbral === null || !cal.zona || app.umbralCamara === null || !app.zona) return false;
  return cal.umbral !== app.umbralCamara || !mismaZona(cal.zona, app.zona);
}
function copiarGuardados() {
  cal.umbral = app.umbralCamara;
  cal.zona = app.zona ? { ...app.zona } : null;
}
// Si no estabas probando nada, el borrador sigue a lo guardado; si sí, se respeta lo que movías
function recibirAjustes(umbral, zona) {
  const estabaLimpio = !hayCambios();
  app.umbralCamara = umbral;
  app.zona = zona;
  if (estabaLimpio || cal.umbral === null) copiarGuardados();
}

function leerCuadro(bytes) {
  const w = bytes[1];
  const h = bytes[2];
  const n = w * h;
  if (!w || !h || bytes.length !== 7 + 3 * n) return null;
  return {
    w, h,
    zona: { x0: bytes[3], x1: bytes[4], y0: bytes[5], y1: bytes[6] }, // en puntos de la miniatura
    ref: bytes.subarray(7, 7 + n),
    cur: bytes.subarray(7 + n, 7 + 2 * n),
    marcas: bytes.subarray(7 + 2 * n, 7 + 3 * n),
  };
}

function capa(cuadro, pixel) {
  const { w, h } = cuadro;
  const lienzo = document.createElement('canvas');
  lienzo.width = w;
  lienzo.height = h;
  const ctx = lienzo.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = pixel(i);
    img.data[4 * i] = r;
    img.data[4 * i + 1] = g;
    img.data[4 * i + 2] = b;
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return lienzo;
}

// ¿La zona que está usando la caneca (viene en cada cuadro) es la guardada?
function zonaCanecaEnPct() {
  const c = dep.cuadro;
  if (!c) return null;
  return { x0: (100 * c.zona.x0) / c.w, x1: (100 * c.zona.x1) / c.w, y0: (100 * c.zona.y0) / c.h, y1: (100 * c.zona.y1) / c.h };
}
function canecaUsaZona(zona) {
  const c = dep.cuadro;
  if (!c || !zona) return false;
  return Math.round((c.w * zona.x0) / 100) === c.zona.x0 && Math.round((c.w * zona.x1) / 100) === c.zona.x1 &&
    Math.round((c.h * zona.y0) / 100) === c.zona.y0 && Math.round((c.h * zona.y1) / 100) === c.zona.y1;
}

function pintarCuadro(cuadro) {
  dep.cuadro = cuadro;
  const sinRef = dep.numeros && dep.numeros.refLista === false;
  const gris = (v) => [v, v, v];
  dep.capas = {
    ref: capa(cuadro, (i) => (sinRef ? [40, 40, 40] : gris(cuadro.ref[i]))),
    cur: capa(cuadro, (i) => gris(cuadro.cur[i])),
    dif: capa(cuadro, (i) => {
      const m = cuadro.marcas[i];
      if (m === 1) return [242, 140, 40]; // cambió el brillo
      if (m === 2) return [59, 130, 246]; // cambió un borde
      return gris(Math.round(cuadro.cur[i] * 0.45));
    }),
  };
  for (const v of ['ref', 'cur', 'dif']) {
    const chico = $(`#dep-${v}`);
    const ctx = chico.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(dep.capas[v], 0, 0, chico.width, chico.height);
    dibujarZona(ctx, chico.width, chico.height, cal.zona, { chica: true });
  }
  pintarGrande();
}

function dibujarZona(ctx, W, H, zona, { chica = false, sucia = false } = {}) {
  if (!zona) return;
  const x = (zona.x0 / 100) * W;
  const y = (zona.y0 / 100) * H;
  const w = ((zona.x1 - zona.x0) / 100) * W;
  const h = ((zona.y1 - zona.y0) / 100) * H;
  if (!chica) {
    // oscurecer lo que queda fuera: eso no se revisa
    ctx.fillStyle = 'rgba(12, 18, 15, 0.55)';
    ctx.fillRect(0, 0, W, y);
    ctx.fillRect(0, y + h, W, H - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, W - x - w, h);
  }
  ctx.lineWidth = chica ? 1.5 : 3;
  ctx.strokeStyle = '#f2c230';
  ctx.setLineDash(sucia || chica ? [] : [10, 6]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  if (chica) return;
  // agarraderas en esquinas y lados
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x + w / 2, y], [x + w / 2, y + h], [x, y + h / 2], [x + w, y + h / 2]];
  for (const [px, py] of pts) {
    ctx.fillStyle = '#f2c230';
    ctx.fillRect(px - 6, py - 6, 12, 12);
    ctx.strokeStyle = '#15211b';
    ctx.lineWidth = 2;
    ctx.strokeRect(px - 6, py - 6, 12, 12);
  }
  if (sucia) {
    const texto = 'Sin guardar';
    ctx.font = '600 15px Archivo, system-ui, sans-serif';
    const ancho = ctx.measureText(texto).width + 14;
    const ty = y > 30 ? y - 28 : y + 10;
    ctx.fillStyle = '#f2c230';
    ctx.fillRect(x + 10, ty, ancho, 22);
    ctx.fillStyle = '#15211b';
    ctx.fillText(texto, x + 17, ty + 16);
  }
}

function pintarGrande() {
  const canvas = $('#dep-grande');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#1b2420';
  ctx.fillRect(0, 0, W, H);
  const fuente = dep.vista === 'foto' ? dep.foto : dep.capas?.[dep.vista];
  if (fuente) {
    ctx.imageSmoothingEnabled = dep.vista === 'foto';
    ctx.drawImage(fuente, 0, 0, W, H);
  }
  // la zona que usa la caneca, si es distinta de la que estás probando
  const enCaneca = zonaCanecaEnPct();
  if (enCaneca && cal.zona && !canecaUsaZona(cal.zona)) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 5]);
    ctx.strokeRect((enCaneca.x0 / 100) * W, (enCaneca.y0 / 100) * H, ((enCaneca.x1 - enCaneca.x0) / 100) * W, ((enCaneca.y1 - enCaneca.y0) / 100) * H);
    ctx.setLineDash([]);
  }
  if (fuente || cal.zona) dibujarZona(ctx, W, H, cal.zona, { sucia: !mismaZona(cal.zona, app.zona) });
  const nombres = { dif: 'Qué cambió', cur: 'Lo que ve ahora', ref: 'Bandeja vacía guardada', foto: 'Foto en color de la captura' };
  canvas.setAttribute('aria-label', `${nombres[dep.vista]}, con la zona que se revisa en amarillo`);
}

const siNo = (v) => (v ? 'sí' : 'no');

function textoEdad(s) {
  if (!Number.isFinite(s)) return '';
  if (s < 90) return `hace ${s} s`;
  if (s < 5400) return `hace ${Math.round(s / 60)} min`;
  return `hace ${coma(s / 3600)} h`;
}

function pintarPasos(n) {
  if (!n) return;
  // 1. Bandeja vacía
  const paso1 = $('#paso-ref');
  let ref;
  if (n.fase === 'tomando_referencia') {
    paso1.dataset.ok = 'medio';
    const mov = Number.isFinite(n.movPct) ? ` Movimiento: ${n.movPct} % (la guarda con menos de ${n.movUmbral ?? 2} %).` : '';
    const lleva = Number.isFinite(n.buscandoS) && n.buscandoS >= 6
      ? ` Lleva ${n.buscandoS} s esperando: si la bandeja está vacía, toca el botón y la guarda de una vez.`
      : '';
    ref = `Guardándola: esperando a que todo esté quieto.${mov}${lleva}`;
  } else if (n.refLista === false) {
    paso1.dataset.ok = 'no';
    ref = 'No hay foto de la bandeja vacía. Deja la bandeja vacía y toca el botón.';
  } else {
    paso1.dataset.ok = 'si';
    ref = `Guardada ${textoEdad(n.refEdadS)}.`.replace(' .', '.');
  }
  $('#dep-ref-estado').textContent = ref;

  // 4. Qué decide
  const cajaCam = $('#dep-paso-cam');
  let cam;
  if (n.fase === 'tomando_referencia') cam = 'Todavía no compara: está guardando la bandeja vacía.';
  else if (n.fase === 'bandeja_no_esta') cam = 'La bandeja no está a nivel: no compara.';
  else if (!Number.isFinite(n.camPct)) cam = 'Sin medida.';
  else {
    cam = `${n.camPct} % de la zona cambió; hay residuo desde ${n.umbral} %: ${siNo(n.camPct >= n.umbral)}.`;
    if (n.camPct >= n.umbral && !n.camVe) cam += n.movPct >= 2 ? ` Se está moviendo (${n.movPct} %): espera a que quede quieto.` : ' Falta que se quede quieto 1 s.';
  }
  cajaCam.dataset.ve = n.camVe ? 'si' : 'no';
  cajaCam.querySelector('dd').textContent = cam;

  const cajaUltra = $('#dep-paso-ultra');
  let ultra;
  if (!Number.isFinite(n.dist) || n.dist <= 0) ultra = 'Sin medida: revisa el sensor y que la bandeja esté a nivel.';
  else if (!Number.isFinite(n.vacia) || n.vacia <= 0) ultra = `${coma(n.dist)} cm ahora; todavía no tiene la distancia de la bandeja vacía.`;
  else {
    const dif = n.vacia - n.dist;
    ultra = dif >= 0
      ? `${coma(dif)} cm más cerca que la bandeja vacía; hay residuo desde ${coma(n.ultraUmbral ?? 1.5)} cm: ${siNo(n.ultraVe)}.`
      : `Mide ${coma(-dif)} cm más lejos que la bandeja vacía.` +
        (dif < -2 ? ' Revisa que la bandeja esté horizontal y el sensor derecho; luego guarda la bandeja vacía otra vez.' : ' Es una variación pequeña.');
  }
  cajaUltra.dataset.ve = n.ultraVe ? 'si' : 'no';
  cajaUltra.querySelector('dd').textContent = ultra;

  const cajaRes = $('#dep-paso-res');
  let res;
  if (n.vaciar) res = 'Modo vaciar: no clasifica hasta que toques Nivelar.';
  else if (n.atascado) res = 'El residuo no cayó al inclinar: sácalo a mano o toca Nivelar.';
  else if (n.pausa) res = 'En pausa: no clasifica sola.';
  else if (n.esperando) res = 'Ya clasificó lo que hay: espera a que la bandeja quede libre.';
  else if (n.camVe || n.ultraVe) res = `Hay residuo (lo ve ${[n.ultraVe && 'el ultrasónico', n.camVe && 'la cámara'].filter(Boolean).join(' y ')}): toma la foto con flash y la manda a la IA.`;
  else res = 'Bandeja libre: no hace nada. Si hay algo y no lo detecta, guárdalo abajo con "No lo detectó".';
  cajaRes.dataset.ve = n.atascado ? 'alerta' : n.camVe || n.ultraVe ? 'si' : 'no';
  cajaRes.querySelector('dd').textContent = res;

  const tec = [];
  if (Number.isFinite(n.ruido)) tec.push(`Ruido de la cámara: ${coma(n.ruido)}. Un punto cuenta si cambia más de ${n.umbralPixel} en brillo o ${n.umbralBorde} en bordes.`);
  if (Number.isFinite(n.corrimiento)) tec.push(`Brillo general corregido en ${n.corrimiento > 0 ? '+' : ''}${n.corrimiento}.`);
  if (Number.isFinite(n.movPct)) tec.push(`Movimiento entre imágenes: ${n.movPct} %.`);
  if (n.fase) tec.push(`Fase: ${n.fase.replace(/_/g, ' ')}.`);
  $('#dep-tecnico').textContent = tec.join(' ') || 'Sin datos.';
}

// Sensibilidad: la barra es el % de ahora, la raya el que estás probando, la punteada lo más alto de 30 s
function pintarSensibilidad() {
  const n = dep.numeros;
  const ahora = n && Number.isFinite(n.camPct) && n.fase === 'comparando' ? n.camPct : null;
  const umbral = cal.umbral ?? 3;
  const ventana = cal.historia.filter(([t]) => Date.now() - t < 30000);
  const maximo = ventana.length ? Math.max(...ventana.map(([, v]) => v)) : null;
  const escala = Math.min(100, Math.max(10, Math.ceil((Math.max(umbral * 2, (maximo ?? 0) * 1.2, ahora ?? 0) + 1) / 5) * 5));
  $('#cal-relleno').style.width = `${ahora === null ? 0 : limitar(ahora / escala, 0, 1) * 100}%`;
  $('#cal-raya').style.left = `${limitar(umbral / escala, 0, 1) * 100}%`;
  $('#cal-raya-texto').textContent = `${umbral} %`;
  $('#cal-max').hidden = maximo === null;
  if (maximo !== null) $('#cal-max').style.left = `${limitar(maximo / escala, 0, 1) * 100}%`;
  $('#cal-escala').textContent = `${escala} %`;
  const ve = ahora !== null && ahora >= umbral;
  $('.regla').dataset.ve = ve ? 'si' : 'no';
  $('#cal-ahora').textContent = ahora === null ? '—' : `${ahora} %`;
  $('#cal-max-texto').textContent = ahora === null
    ? 'La cámara todavía no está comparando.'
    : `cambió ahora${maximo !== null ? `; lo más alto en los últimos 30 s fue ${maximo} % (raya punteada)` : ''}.`;
  $('#o-umbral').textContent = `${umbral} %`;

  let veredicto;
  if (ahora === null) veredicto = 'Cuando la cámara compare, aquí ves si con este valor detectaría algo.';
  else veredicto = ve ? `Con ${umbral} %, la cámara diría que hay un residuo.` : `Con ${umbral} %, la cámara diría que la bandeja está libre.`;
  if (cal.umbral !== app.umbralCamara) veredicto += ` Es una prueba: la caneca sigue usando ${app.umbralCamara} % hasta que guardes.`;
  if (!mismaZona(cal.zona, app.zona)) veredicto += ' El % se vuelve a medir con la zona nueva cuando la guardes.';
  $('#cal-veredicto').textContent = veredicto;
  $('#paso-sens').dataset.ok = ahora === null ? '' : 'si';
}

function pintarDeslizadores() {
  if (!cal.zona) return;
  for (const k of LADOS_ZONA) {
    const input = $(`#zona-${k}`);
    if (document.activeElement !== input || !cal.arrastre) input.value = cal.zona[k];
    $(`#o-${k}`).textContent = `${cal.zona[k]} %`;
  }
  if (cal.umbral !== null) $('#umbral-cam').value = cal.umbral;
}

function pintarGuardar() {
  const barra = $('#guardar-barra');
  const cambios = hayCambios();
  const guardar = $('#btn-ajustes');
  barra.dataset.estado = cambios ? 'sucio' : 'limpio';
  $('#btn-descartar').hidden = !cambios;
  const z = app.zona;
  const actual = z && app.umbralCamara !== null
    ? `hay residuo desde ${app.umbralCamara} %, zona de ${z.x0} a ${z.x1} % a lo ancho y de ${z.y0} a ${z.y1} % a lo alto`
    : null;
  let texto;
  if (!actual) texto = 'Cargando los ajustes…';
  else if (!cambios) texto = `La caneca usa: ${actual}. Mueve la zona o la sensibilidad para probar.`;
  else if (manejo()) texto = `Tienes cambios sin guardar. La caneca sigue usando lo anterior: ${actual}.`;
  else texto = 'Estás probando sin guardar. Para que la caneca use estos valores necesitas el control con el PIN.';
  if (cambios && !app.online && manejo()) texto += ' La caneca no está conectada: se le mandan cuando se conecte.';
  $('#guardar-texto').textContent = texto;
  if (cambios && !manejo()) {
    guardar.textContent = app.control.estado === 'espera' ? 'Esperando tu turno' : 'Tomar el control';
    guardar.disabled = app.control.estado === 'espera' || !app.servidor;
    guardar.dataset.accion = 'control';
  } else {
    guardar.textContent = 'Guardar en la caneca';
    guardar.disabled = !cambios || !app.servidor;
    guardar.dataset.accion = 'guardar';
  }
}

function pintarEstadoCal() {
  const ahora = Date.now();
  const enVivo = !dep.viendoCaptura && !dep.congelado;
  // con la caneca desconectada, el servidor puede mandar la última imagen que guardó: no es en vivo
  const fresco = app.online && ahora - dep.ultimoCuadro < 4000;

  // Imagen
  const ceImagen = $('#ce-imagen');
  let imagen;
  if (dep.viendoCaptura) [ceImagen.dataset.ok, imagen] = ['medio', 'revisando una captura'];
  else if (dep.congelado) [ceImagen.dataset.ok, imagen] = ['medio', 'congelada'];
  else if (fresco) [ceImagen.dataset.ok, imagen] = ['si', 'en vivo'];
  else [ceImagen.dataset.ok, imagen] = ['no', 'sin imagen'];
  ceImagen.querySelector('b').textContent = imagen;

  // Bandeja vacía
  const n = dep.numeros;
  const ceRef = $('#ce-ref');
  let ref = 'sin datos';
  ceRef.dataset.ok = '';
  if (n && (app.online || !enVivo)) {
    if (n.fase === 'tomando_referencia') [ceRef.dataset.ok, ref] = ['medio', 'guardándose'];
    else if (n.refLista === false) [ceRef.dataset.ok, ref] = ['no', 'no hay'];
    else [ceRef.dataset.ok, ref] = ['si', `guardada ${textoEdad(n.refEdadS)}`.trim()];
  }
  ceRef.querySelector('b').textContent = ref;

  // Ajustes
  const ceAj = $('#ce-ajustes');
  let aj = 'sin datos';
  ceAj.dataset.ok = '';
  if (hayCambios()) [ceAj.dataset.ok, aj] = ['medio', 'probando sin guardar'];
  else if (!app.online) aj = 'la caneca no está conectada';
  else if (dep.cuadro && n && Number.isFinite(n.umbral)) {
    const usa = canecaUsaZona(app.zona) && n.umbral === app.umbralCamara;
    [ceAj.dataset.ok, aj] = usa ? ['si', 'la caneca ya los usa'] : ['medio', 'la caneca todavía no los recibe'];
  }
  ceAj.querySelector('b').textContent = aj;
  $('#paso-zona').dataset.ok = !mismaZona(cal.zona, app.zona) ? 'medio' : canecaUsaZona(app.zona) ? 'si' : '';

  // Por qué no hay imagen
  const vacio = $('#lienzo-vacio');
  const sinImagen = enVivo && !fresco;
  vacio.hidden = !sinImagen;
  if (sinImagen) {
    let razon;
    if (!app.servidor) razon = 'Sin conexión con el servidor. Cuando vuelva, aquí aparece lo que ve la caneca.';
    else if (!app.online) razon = 'La caneca no está conectada. Revisa que esté prendida y con Wi-Fi; cuando se conecte, aquí aparece lo que ve.';
    else if (firmwareViejo()) razon = `La caneca tiene el programa ${app.estado?.fw || 'viejo'} y esta parte necesita el ${FIRMWARE_ESPERADO} o uno más nuevo. Cárgale el programa de la carpeta Caneca3 con el Arduino IDE.`;
    else if (ahora - dep.pedidoDesde < 6000) razon = 'Pidiendo las imágenes a la caneca… llega una cada segundo.';
    else razon = 'La caneca está conectada pero no manda las imágenes. Recarga la página; si sigue igual, reinicia la caneca.';
    $('#lienzo-vacio-texto').textContent = razon;
  }
  if (enVivo && dep.cuadro) {
    const hace = Math.round((ahora - dep.ultimoCuadro) / 1000);
    $('#dep-fuente').textContent = fresco ? 'En vivo' : `Última imagen ${textoEdad(hace)}`;
  }
}

function pintarCal() {
  pintarDeslizadores();
  pintarSensibilidad();
  pintarGuardar();
  pintarEstadoCal();
  pintarGrande();
  // las miniaturas también muestran la zona que estás probando
  if (dep.cuadro && dep.capas) {
    for (const v of ['ref', 'cur', 'dif']) {
      const chico = $(`#dep-${v}`);
      const ctx = chico.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(dep.capas[v], 0, 0, chico.width, chico.height);
      dibujarZona(ctx, chico.width, chico.height, cal.zona, { chica: true });
    }
  }
}

function recibirNumeros(n) {
  if (Number.isFinite(n.camPct) && n.fase === 'comparando') {
    cal.historia.push([Date.now(), n.camPct]);
    cal.historia = cal.historia.filter(([t]) => Date.now() - t < 30000);
  }
  if (dep.congelado || dep.viendoCaptura) return;
  dep.numeros = n;
  pintarPasos(n);
  pintarSensibilidad();
}

function recibirCuadro(bytes) {
  if (dep.congelado || dep.viendoCaptura) return;
  const cuadro = leerCuadro(bytes);
  if (!cuadro) return;
  dep.ultimoCuadro = Date.now();
  pintarCuadro(cuadro);
  pintarEstadoCal();
}

function volverAVivo() {
  dep.viendoCaptura = null;
  dep.congelado = false;
  dep.foto = null;
  if (dep.vista === 'foto') elegirVista('dif');
  $('#dep-congelar').textContent = 'Congelar imagen';
  $('#revision').hidden = true;
  $('#vista-foto').hidden = true;
  $('#dep-fuente').textContent = 'En vivo';
  pintarCal();
}

async function abrirCaptura(id) {
  mostrarPanel('calibrar');
  try {
    const r = await fetch(`/api/capturas/${id}`);
    if (!r.ok) throw new Error('no existe');
    const c = await r.json();
    const bytes = Uint8Array.from(atob(c.cuadro), (ch) => ch.charCodeAt(0));
    const cuadro = leerCuadro(bytes);
    if (!cuadro) throw new Error('dañada');
    dep.viendoCaptura = id;
    dep.numeros = c.datos || {};
    pintarCuadro(cuadro);
    pintarPasos(dep.numeros);
    pintarSensibilidad();
    const tipo = app.tiposCaptura[c.tipo] || 'Captura';
    const fecha = new Date(c.fecha).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    $('#revision-texto').textContent = `Revisando la captura del ${fecha}: ${tipo}${c.nota ? `, «${c.nota}»` : ''}. Las imágenes y los números son de ese momento.`;
    $('#revision').hidden = false;
    $('#dep-fuente').textContent = `Captura del ${fecha}`;
    $('#vista-foto').hidden = !c.foto;
    if (c.foto) {
      const src = `/capturas/${id}.jpg`;
      $('#dep-foto').src = src;
      const img = new Image();
      img.onload = () => {
        dep.foto = img;
        if (dep.vista === 'foto') pintarGrande();
      };
      img.src = src;
    }
    pintarEstadoCal();
    $('#revision').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    avisar('No se pudo abrir esa captura (puede que ya se haya borrado).', 'error');
  }
}

function pintarCapturas() {
  const lista = $('#dep-capturas');
  lista.replaceChildren();
  for (const c of app.capturas) {
    const li = document.createElement('li');
    const cuando = document.createElement('time');
    cuando.textContent = hora(c.fecha);
    const que = document.createElement('div');
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'boton-texto';
    boton.textContent = app.tiposCaptura[c.tipo] || 'Captura';
    boton.addEventListener('click', () => abrirCaptura(c.id));
    que.append(boton);
    if (c.nota) que.append(` «${c.nota}»`);
    const datos = [
      Number.isFinite(c.camPct) ? `cámara ${c.camPct} %` : null,
      Number.isFinite(c.dist) && Number.isFinite(c.vacia) ? `ultrasónico ${coma(c.dist)} cm (vacía ${coma(c.vacia)} cm)` : null,
    ].filter(Boolean).join(', ');
    if (datos) {
      const pie = document.createElement('small');
      pie.textContent = datos;
      que.append(pie);
    }
    li.append(cuando, que);
    lista.append(li);
  }
  $('#dep-capturas-vacio').hidden = app.capturas.length > 0;
}

// --- Elegir qué imagen ver en grande
function elegirVista(v) {
  dep.vista = v;
  for (const b of $$('.vista')) b.setAttribute('aria-pressed', String(b.dataset.vista === v));
  pintarGrande();
}
for (const b of $$('.vista')) b.addEventListener('click', () => elegirVista(b.dataset.vista));

// --- Mover la zona con las barras
function ponerZona(nueva, fijo) {
  const z = { ...nueva };
  for (const k of LADOS_ZONA) z[k] = Math.round(limitar(z[k], 0, 100));
  // al menos 10 % entre un borde y el otro, como pide el servidor
  if (z.x1 - z.x0 < 10) {
    if (fijo === 'x0') z.x1 = Math.min(100, z.x0 + 10);
    else z.x0 = Math.max(0, z.x1 - 10);
    if (z.x1 - z.x0 < 10) z.x0 = z.x1 - 10;
  }
  if (z.y1 - z.y0 < 10) {
    if (fijo === 'y0') z.y1 = Math.min(100, z.y0 + 10);
    else z.y0 = Math.max(0, z.y1 - 10);
    if (z.y1 - z.y0 < 10) z.y0 = z.y1 - 10;
  }
  cal.zona = z;
  pintarCal();
}

for (const k of LADOS_ZONA) {
  $(`#zona-${k}`).addEventListener('input', (ev) => {
    if (!cal.zona) return;
    const otro = { x0: 'x1', x1: 'x0', y0: 'y1', y1: 'y0' }[k];
    let v = Number(ev.target.value);
    // un borde no puede pasar al otro
    v = k.endsWith('0') ? Math.min(v, cal.zona[otro] - 10) : Math.max(v, cal.zona[otro] + 10);
    ev.target.value = v;
    ponerZona({ ...cal.zona, [k]: v }, k);
  });
}

$('#umbral-cam').addEventListener('input', (ev) => {
  cal.umbral = Number(ev.target.value);
  pintarSensibilidad();
  pintarGuardar();
  pintarEstadoCal();
});

$('#btn-zona-sugerida').addEventListener('click', () => ponerZona(ZONA_SUGERIDA));

// --- Mover la zona arrastrando en la imagen (con el dedo, solo con "Mover la zona" prendido)
const lienzo = $('#dep-grande');
function puntoEnPct(ev) {
  const r = lienzo.getBoundingClientRect();
  return { x: limitar(((ev.clientX - r.left) / r.width) * 100, 0, 100), y: limitar(((ev.clientY - r.top) / r.height) * 100, 0, 100) };
}
function queAgarra(p, tactil) {
  const z = cal.zona;
  if (!z) return null;
  const tx = tactil ? 7 : 3.5;
  const ty = tx * (4 / 3);
  const dentroX = p.x > z.x0 - tx && p.x < z.x1 + tx;
  const dentroY = p.y > z.y0 - ty && p.y < z.y1 + ty;
  const lados = [];
  if (dentroY) {
    if (Math.abs(p.x - z.x0) < tx) lados.push('x0');
    else if (Math.abs(p.x - z.x1) < tx) lados.push('x1');
  }
  if (dentroX) {
    if (Math.abs(p.y - z.y0) < ty) lados.push('y0');
    else if (Math.abs(p.y - z.y1) < ty) lados.push('y1');
  }
  if (lados.length) return { lados };
  if (p.x > z.x0 && p.x < z.x1 && p.y > z.y0 && p.y < z.y1) return { mover: true };
  return null;
}
function cursorPara(agarre) {
  if (!agarre) return 'default';
  if (agarre.mover) return 'move';
  const l = agarre.lados.join('');
  if (l === 'x0y0' || l === 'x1y1') return 'nwse-resize';
  if (l === 'x1y0' || l === 'x0y1') return 'nesw-resize';
  return l.startsWith('x') ? 'ew-resize' : 'ns-resize';
}

lienzo.addEventListener('pointerdown', (ev) => {
  if (!cal.zona) return;
  if (ev.pointerType === 'touch' && !cal.editarZona) return;
  const p = puntoEnPct(ev);
  const agarre = queAgarra(p, ev.pointerType !== 'mouse');
  if (!agarre) return;
  cal.arrastre = { ...agarre, inicio: p, zonaInicio: { ...cal.zona } };
  lienzo.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
lienzo.addEventListener('pointermove', (ev) => {
  const p = puntoEnPct(ev);
  const a = cal.arrastre;
  if (!a) {
    if (ev.pointerType === 'mouse') lienzo.style.cursor = cursorPara(queAgarra(p, false));
    return;
  }
  const z0 = a.zonaInicio;
  if (a.mover) {
    const dx = limitar(p.x - a.inicio.x, -z0.x0, 100 - z0.x1);
    const dy = limitar(p.y - a.inicio.y, -z0.y0, 100 - z0.y1);
    ponerZona({ x0: z0.x0 + dx, x1: z0.x1 + dx, y0: z0.y0 + dy, y1: z0.y1 + dy });
  } else {
    const z = { ...cal.zona };
    for (const k of a.lados) {
      const v = k.startsWith('x') ? p.x : p.y;
      const otro = { x0: 'x1', x1: 'x0', y0: 'y1', y1: 'y0' }[k];
      z[k] = k.endsWith('0') ? Math.min(v, z[otro] - 10) : Math.max(v, z[otro] + 10);
    }
    ponerZona(z, a.lados[0]);
  }
});
for (const tipo of ['pointerup', 'pointercancel']) lienzo.addEventListener(tipo, () => (cal.arrastre = null));

$('#btn-mover-zona').addEventListener('click', () => {
  cal.editarZona = !cal.editarZona;
  $('#btn-mover-zona').setAttribute('aria-pressed', String(cal.editarZona));
  $('#btn-mover-zona').textContent = cal.editarZona ? 'Listo, dejar de mover' : 'Mover la zona con el dedo';
  $('#lienzo').dataset.editar = cal.editarZona ? 'si' : 'no';
});

// --- Guardar o descartar
$('#btn-ajustes').addEventListener('click', () => {
  if ($('#btn-ajustes').dataset.accion === 'control') return irAlPin();
  if (!hayCambios()) return;
  mandar({ t: 'ajustes', umbralCamara: cal.umbral, zona: { ...cal.zona } });
});
$('#btn-descartar').addEventListener('click', () => {
  copiarGuardados();
  pintarCal();
  avisar('Cambios descartados: volviste a lo que usa la caneca.', 'ok');
});

$('#dep-congelar').addEventListener('click', () => {
  if (dep.viendoCaptura) return volverAVivo();
  dep.congelado = !dep.congelado;
  $('#dep-congelar').textContent = dep.congelado ? 'Seguir en vivo' : 'Congelar imagen';
  $('#dep-fuente').textContent = dep.congelado ? 'Congelada' : 'En vivo';
  pintarEstadoCal();
});
$('#dep-vivo').addEventListener('click', volverAVivo);

for (const boton of $$('.dep-captura')) {
  boton.addEventListener('click', () => {
    mandar({ t: 'captura', tipo: boton.dataset.tipo, nota: $('#dep-nota').value.trim(), clasificar: boton.dataset.clasificar === '1' });
    $('#dep-nota').value = '';
  });
}

// Avisar antes de salir si quedaron cambios sin guardar
window.addEventListener('beforeunload', (ev) => {
  if (hayCambios() && manejo()) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Botones
// ---------------------------------------------------------------------------
document.addEventListener('click', (evento) => {
  const boton = evento.target.closest('[data-orden]');
  if (!boton || boton.disabled) return;
  let accion = boton.dataset.orden;
  if (accion === 'pausa' && app.estado?.pausa) accion = 'reanudar';
  if (accion === 'referencia') cal.historia = [];
  mandar({ t: 'orden', a: accion });
});

// Tomar el control (o ponerse en la fila) con el PIN
$('#form-control').addEventListener('submit', (evento) => {
  evento.preventDefault();
  const pin = $('#pin').value.trim();
  if (!pin) {
    avisar('Escribe el PIN para tomar el control.', 'error');
    marcarPinMalo();
    $('#pin').focus();
    return;
  }
  guardarSesion('pin-caneca', pin);
  if (!mandar({ t: 'pedirControl', pin })) return;
  // si el servidor no contesta, casi siempre es un servidor viejo todavía prendido
  const antes = app.control.estado;
  setTimeout(() => {
    if (app.control.estado === antes && antes === 'mirando' && app.servidor) {
      avisar('El servidor no respondió al pedir el control. Si está en tu computador, reinícialo (Ctrl+C y npm start) y recarga la página.', 'error');
    }
  }, 3000);
});

$('#btn-soltar').addEventListener('click', () => {
  guardarSesion('control-caneca', null);
  mandar({ t: 'soltarControl' });
});

let confirmarReinicio = 0;
$('#btn-reiniciar').addEventListener('click', () => {
  const boton = $('#btn-reiniciar');
  if (Date.now() - confirmarReinicio > 4000) {
    confirmarReinicio = Date.now();
    boton.textContent = 'Toca otra vez para borrar todo';
    setTimeout(() => (boton.textContent = 'Reiniciar estadísticas'), 4000);
    return;
  }
  mandar({ t: 'reiniciar' });
  boton.textContent = 'Reiniciar estadísticas';
  confirmarReinicio = 0;
});
setInterval(() => {
  if (panelActual === 'analisis') pintarActividad();
}, 60000);

$('#pin').value = leerSesion('pin-caneca') || '';
mostrarPanel(location.hash.slice(1) || 'vivo', { subir: false });
pintarControl();
pintarConexion();
conectar();
