'use strict';

// Debe ser la misma del servidor (server.js) y del programa de la placa: si no, se avisa arriba
const VERSION_PAGINA = '2026-10-17.4';

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
  auto: 'automático (ultrasónico o cámara)',
  boton: 'botón Clasificar',
  monitor: 'desde el monitor',
};
const $ = (selector) => document.querySelector(selector);
const coma = (n, dec = 1) => Number(n).toFixed(dec).replace('.', ',');

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
    if ($('#depuracion').open) mandar({ t: 'depurar', activo: true });
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
      if (bytes[0] === 0x44) recibirCuadro(bytes); // 'D': miniaturas de la depuración
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
    case 'resumen':
      app.versionServidor = m.version || null;
      app.online = m.online;
      app.estado = m.estado;
      app.conteos = m.conteos || {};
      app.eventos = m.eventos || [];
      app.umbralCamara = m.umbralCamara ?? app.umbralCamara;
      app.zona = m.zona || app.zona;
      app.capturas = m.capturas || [];
      app.tiposCaptura = m.tiposCaptura || app.tiposCaptura;
      if (m.lados) app.lados = m.lados;
      if (m.estadisticas) app.estadisticas = m.estadisticas;
      if (m.clases) {
        app.clases = m.clases;
        NOMBRE_CLASE = { error: 'Sin respuesta de la IA', ...Object.fromEntries(m.clases.map((c) => [c.id, c.nombre])) };
      }
      pintarTodo();
      break;
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
      app.umbralCamara = m.umbralCamara;
      app.zona = m.zona;
      pintarAjustesCamara();
      pintarEstado();
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
      break;
    default:
      break;
  }
}

function mandar(mensaje) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    avisar('No hay conexión con el servidor.', 'error');
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
        : 'La caneca no está conectada';
  }
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
  pintarAjustesCamara();
  pintarCapturas();
}

// Página y servidor de versiones distintas = casi siempre un servidor viejo que sigue prendido
function pintarVersion() {
  const aviso = $('#aviso-version');
  const igual = app.versionServidor === VERSION_PAGINA;
  aviso.hidden = !app.servidor || igual;
  aviso.textContent = igual
    ? ''
    : `El servidor tiene otra versión (${app.versionServidor || 'vieja'}) que esta página (${VERSION_PAGINA}), y por eso algunos botones no funcionan. ` +
      'Si el servidor está en tu computador: ciérralo con Ctrl+C, ábrelo otra vez con npm start y recarga esta página.';
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
  const manejo = app.control.estado === 'tuyo';
  for (const boton of document.querySelectorAll('[data-orden]')) boton.disabled = !app.online || !manejo;
  for (const boton of document.querySelectorAll('.dep-captura')) boton.disabled = !manejo;
  $('#btn-ajustes').disabled = !manejo;
  $('#btn-reiniciar').disabled = !manejo;
  $('#control').hidden = !app.servidor;
}

function pintarControl() {
  const c = app.control;
  const caja = $('#control');
  caja.dataset.estado = c.estado;
  // cuántas personas (aparte de ti) solo miran: ni manejan ni están en la fila
  const soloMiran = Math.max(0, c.mirando - (c.ocupado ? 1 : 0) - c.enFila - (c.estado === 'mirando' ? 1 : 0));
  const otros = soloMiran ? ` · ${soloMiran} ${soloMiran === 1 ? 'persona más solo mira' : 'personas más solo miran'}` : '';
  let titulo;
  let texto;
  if (c.estado === 'tuyo') {
    titulo = 'Tienes el control';
    texto = (c.enFila ? `${c.enFila} ${c.enFila === 1 ? 'persona espera' : 'personas esperan'} su turno. ` : 'Los demás solo pueden mirar. ') +
      'Cuando termines, deja el control.' + otros;
    if (!app.online) texto = 'La caneca no está conectada al servidor: los botones se activan solos cuando se conecte. ' + texto;
  } else if (c.estado === 'espera') {
    titulo = `En la fila: puesto ${c.puesto}`;
    texto = 'Otra persona está manejando la caneca. Cuando termine, el control pasa a ti solo; deja esta página abierta.' + otros;
  } else if (c.ocupado) {
    titulo = 'Otra persona está manejando la caneca';
    texto = 'Puedes mirar. Si escribes el PIN quedas en la fila' + (c.enFila ? ` (hay ${c.enFila} esperando)` : '') + '.' + otros;
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
    if (canecas.includes('verde') && canecas.includes('negra')) texto = 'Todo lo demás';
    else if (canecas.length) texto = canecas.map((k) => CANECA[k].titulo).join(' · ');
    $(ui.destino).textContent = `${texto} · ${ANGULO[lado]}°`;
  }
}

const NOMBRE_VACIAR = { aprovechables: 'aprovechables', no_aprovechables: 'no aprovechables' };

function textoDeteccion(e) {
  if (e.atascado) return ['El residuo no cayó', 'Sácalo a mano o toca Nivelar'];
  if (e.vaciar) return ['Modo vaciar', `Bandeja de canto hacia ${NOMBRE_VACIAR[e.vaciarLado] || 'un lado'}: toca Nivelar al terminar`];
  if (e.pausa) return ['En pausa', 'No clasifica solo; toca Reanudar'];
  if (e.esperando && (e.ultra || e.cam)) return ['Ya se clasificó', 'Espera a que la bandeja quede libre'];
  if (e.ultra && e.cam) return ['Residuo', 'Lo ven el ultrasónico y la cámara'];
  if (e.ultra) return ['Residuo', 'Lo ve el ultrasónico (la cámara no)'];
  if (e.cam) return ['Residuo', 'Lo ve la cámara (el ultrasónico no)'];
  return ['Bandeja libre', 'Ninguno de los dos ve algo'];
}

function pintarEstado() {
  const e = app.estado;
  if (!e) return;
  // Ultrasónico
  const umbralCm = e.ultraUmbral ?? 1.5;
  $('#s-ultra').dataset.ve = e.ultra ? 'si' : 'no';
  if (e.dist === null || e.dist === undefined) {
    $('#s-dist').textContent = '—';
    $('#s-dist-sub').textContent = 'Sin medida: revisa el sensor';
  } else {
    $('#s-dist').textContent = `${coma(e.dist)} cm`;
    $('#s-dist-sub').textContent = e.vacia
      ? `Bandeja vacía: ${coma(e.vacia)} cm · ${coma(e.vacia - e.dist)} cm más cerca (hay residuo desde ${coma(umbralCm)} cm)`
      : 'Midiendo la bandeja vacía…';
  }
  // Cámara
  $('#s-cam').dataset.ve = e.cam ? 'si' : 'no';
  $('#s-campct').textContent = e.camPct === null || e.camPct === undefined ? '—' : `${e.camPct} %`;
  $('#s-cam-sub').textContent =
    e.camPct === null || e.camPct === undefined
      ? 'Guardando la foto de la bandeja vacía…'
      : `de la bandeja cambió (hay residuo desde ${app.umbralCamara ?? 3} %)`;
  // Detección y servo
  const [det, detSub] = textoDeteccion(e);
  $('#s-detec').textContent = det;
  $('#s-detec-sub').textContent = detSub;
  $('#s-det').dataset.ve = e.atascado ? 'alerta' : e.ultra || e.cam ? 'si' : 'no';
  $('#s-servo').textContent = `${e.servo}°`;
  $('#s-modo').textContent = e.servo === 90 ? 'A nivel' : e.servo >= 140 ? 'Hacia aprovechables' : e.servo <= 40 ? 'Hacia no aprovechables' : 'Moviéndose';
  $('#s-pie').textContent =
    `Wi-Fi: ${e.rssi === null || e.rssi === undefined ? 'sin datos' : `${e.rssi} dBm`}` + (e.fw ? ` · Programa de la caneca: ${e.fw}` : '');
  const avisoFw = $('#aviso-fw');
  const fwDistinto = app.online && e.fw !== VERSION_PAGINA;
  avisoFw.hidden = !fwDistinto;
  avisoFw.textContent = fwDistinto
    ? `La caneca tiene otra versión del programa (${e.fw || 'vieja'}; esta página es ${VERSION_PAGINA}). Vuelve a cargarle el programa desde Caneca3 para que todo funcione.`
    : '';

  // La página de la caneca (Wi-Fi) también se abre desde la misma red, por su IP
  const pagina = $('#e-pagina');
  pagina.replaceChildren();
  if (e.ip) {
    const enlace = document.createElement('a');
    enlace.href = `http://${e.ip}/`;
    enlace.target = '_blank';
    enlace.rel = 'noopener';
    enlace.textContent = `http://${e.ip}`;
    pagina.append(enlace, ' (desde tu misma red Wi-Fi) o http://192.168.4.1 conectado a la red Caneca-IoT');
  } else {
    pagina.textContent = 'http://192.168.4.1 conectado a la red Caneca-IoT';
  }

  const pausa = $('#btn-pausa');
  pausa.textContent = e.pausa ? 'Reanudar clasificación' : 'Pausar clasificación';
  pausa.setAttribute('aria-pressed', String(Boolean(e.pausa)));

  const flash = $('#btn-flash');
  flash.textContent = e.flash ? 'Apagar flash' : 'Prender flash';
  flash.setAttribute('aria-pressed', String(Boolean(e.flash)));
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
  const ahora = new Date();
  const horaActual = new Date(ahora);
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
    col.title = `${String(h).padStart(2, '0')}:00 · ${c.si} aprovechables, ${c.no} no aprovechables`;
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

  $('#tasa-pct').textContent = total ? `${pct(si, total)}%` : '—';
  $('#tasa-sub').textContent = total
    ? `${fmt.format(si)} de ${fmt.format(total)} residuos se pueden reciclar`
    : 'Todavía no hay residuos clasificados';
  $('#seg-si').style.width = `${total ? (si / total) * 100 : 0}%`;
  $('#seg-no').style.width = `${total ? (no / total) * 100 : 0}%`;
  $('#tasa-barra').setAttribute('aria-label', `${pct(si, total)}% aprovechables, ${pct(no, total)}% no aprovechables`);
  $('#n-si').textContent = `${fmt.format(si)} · ${pct(si, total)}%`;
  $('#n-no').textContent = `${fmt.format(no)} · ${pct(no, total)}%`;

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

function hora(iso) {
  const fecha = new Date(iso);
  const hhmm = fecha.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  if (fecha.toDateString() === new Date().toDateString()) return hhmm;
  return `${fecha.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}, ${hhmm}`;
}

function textoLado(lado) {
  if (lado === 'aprovechables') return 'a aprovechables';
  if (lado === 'no_aprovechables') return 'a no aprovechables';
  if (lado === 'izquierda' || lado === 'derecha') return `a la ${lado}`; // eventos viejos
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
    const tiempo = evento.ms ? ` (${coma(evento.ms / 1000)} s)` : '';
    const accion = evento.lado === 'nivel' && QUE_HACER[evento.caneca] ? QUE_HACER[evento.caneca] : textoLado(evento.lado);
    return `${NOMBRE_CLASE[evento.clase] || evento.clase}, ${accion}${tiempo}`;
  }
  if (evento.lado === 'nivel') return 'Bandeja nivelada';
  if (evento.lado === 'vaciar_aprovechables') return 'Bandeja de canto para vaciar aprovechables';
  if (evento.lado === 'vaciar_no_aprovechables' || evento.lado === 'vaciar') return 'Bandeja de canto para vaciar no aprovechables';
  return `Bandeja inclinada ${textoLado(evento.lado)}`;
}

function enlace(texto, href, alClic) {
  const a = document.createElement('a');
  a.textContent = texto;
  a.href = href;
  if (alClic) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      alClic();
    });
  } else {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return a;
}

function pintarHistorial() {
  const lista = $('#historial');
  lista.replaceChildren();
  for (const evento of app.eventos) {
    const fila = document.createElement('li');

    const cuando = document.createElement('time');
    cuando.dateTime = evento.fecha;
    cuando.textContent = hora(evento.fecha);

    const que = document.createElement('span');
    que.textContent = describir(evento);
    if (evento.nota && evento.tipo === 'clasificacion') que.title = evento.nota;
    // la foto que vio la IA, o la captura de depuración, para revisarla
    if (evento.tipo === 'clasificacion' && evento.foto) que.append(' · ', enlace('foto', `/fotos/${evento.id}.jpg`));
    if (evento.tipo === 'captura' && evento.capturaId) que.append(' · ', enlace('revisar', '#depuracion', () => abrirCaptura(evento.capturaId)));

    const origen = document.createElement('span');
    origen.className = 'historial-origen';
    origen.textContent = NOMBRE_ORIGEN[evento.origen] || '';

    fila.append(cuando, que, origen);
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
  $('#ultima-texto').textContent = `${describir(ultima)}, ${hora(ultima.fecha)}`;
  foto.href = ultima.foto ? `/fotos/${ultima.id}.jpg` : `/ultima.jpg?v=${ultima.id}`;
  foto.hidden = false;
}

let temporizadorAviso = null;
function avisar(texto, tipo) {
  const aviso = $('#aviso');
  aviso.textContent = texto;
  aviso.dataset.tipo = tipo;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => {
    aviso.textContent = '';
  }, 6000);
}

// ---------------------------------------------------------------------------
// Depuración paso a paso
// La placa manda (solo mientras esta sección está abierta) tres miniaturas en gris:
// la bandeja vacía que tiene guardada, lo que ve ahora y qué puntos cambiaron.
// ---------------------------------------------------------------------------
const dep = {
  congelado: false,
  viendoCaptura: null, // id de la captura que se está revisando (null = en vivo)
  numeros: null,
  cuadro: null,
};

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

function dibujar(canvas, cuadro, pixel) {
  const { w, h } = cuadro;
  const chico = document.createElement('canvas');
  chico.width = w;
  chico.height = h;
  const ctx = chico.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = pixel(i);
    img.data[4 * i] = r;
    img.data[4 * i + 1] = g;
    img.data[4 * i + 2] = b;
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const grande = canvas.getContext('2d');
  grande.imageSmoothingEnabled = false;
  grande.drawImage(chico, 0, 0, canvas.width, canvas.height);
  // la zona que se revisa
  const sx = canvas.width / w;
  const sy = canvas.height / h;
  const z = cuadro.zona;
  grande.strokeStyle = '#f2c230';
  grande.lineWidth = 2;
  grande.setLineDash([6, 4]);
  grande.strokeRect(z.x0 * sx + 1, z.y0 * sy + 1, (z.x1 - z.x0) * sx - 2, (z.y1 - z.y0) * sy - 2);
  grande.setLineDash([]);
}

function pintarCuadro(cuadro) {
  dep.cuadro = cuadro;
  const sinRef = dep.numeros && dep.numeros.refLista === false;
  dibujar($('#dep-ref'), cuadro, (i) => (sinRef ? [40, 40, 40] : [cuadro.ref[i], cuadro.ref[i], cuadro.ref[i]]));
  dibujar($('#dep-cur'), cuadro, (i) => [cuadro.cur[i], cuadro.cur[i], cuadro.cur[i]]);
  dibujar($('#dep-dif'), cuadro, (i) => {
    const m = cuadro.marcas[i];
    if (m === 1) return [242, 140, 40]; // cambió el brillo
    if (m === 2) return [59, 130, 246]; // cambió un borde
    const g = Math.round(cuadro.cur[i] * 0.45);
    return [g, g, g];
  });
}

const siNo = (v) => (v ? 'SÍ' : 'no');

function pintarPasos(n) {
  if (!n) return;
  // 1. Referencia
  $('#dep-ref-edad').textContent = n.refLista === false
    ? '(todavía no hay)'
    : Number.isFinite(n.refEdadS)
      ? `(hace ${n.refEdadS < 90 ? `${n.refEdadS} s` : `${Math.round(n.refEdadS / 60)} min`})`
      : '';
  // 4. Cámara
  let cam;
  if (n.fase === 'tomando_referencia') cam = 'guardando la foto de la bandeja vacía: espera a que todo esté quieto y sin manos.';
  else if (n.fase === 'bandeja_no_esta') cam = 'la bandeja no está a nivel: no se compara.';
  else if (!Number.isFinite(n.camPct)) cam = 'sin medida.';
  else {
    cam = `${n.camPct} % de la zona cambió; hay residuo desde ${n.umbral} % → ${siNo(n.camPct >= n.umbral)}. ` +
      `Quieto: ${n.movPct < 2 ? 'sí' : `no, se está moviendo (${n.movPct} %)`}. ` +
      `Brillo general corregido en ${n.corrimiento > 0 ? '+' : ''}${n.corrimiento}. ` +
      (n.camVe ? 'La cámara avisa que HAY residuo.' : n.camPct >= n.umbral ? 'Falta que se quede quieto 1 s.' : 'La cámara no ve nada.');
  }
  $('#dep-paso-cam span').textContent = cam;
  // 5. Ultrasónico
  let ultra;
  if (!Number.isFinite(n.dist) || n.dist <= 0) ultra = 'sin medida (revisa el sensor o que la bandeja esté a nivel).';
  else if (!Number.isFinite(n.vacia) || n.vacia <= 0) ultra = `${coma(n.dist)} cm ahora; todavía no tiene la distancia de la bandeja vacía.`;
  else {
    const dif = n.vacia - n.dist;
    ultra = `${coma(n.dist)} cm ahora, ${coma(n.vacia)} cm con la bandeja vacía: ${coma(dif)} cm más cerca; ` +
      `hay residuo desde ${coma(n.ultraUmbral ?? 1.5)} cm → ${siNo(n.ultraVe)}.`;
  }
  $('#dep-paso-ultra span').textContent = ultra;
  // 6. Resultado
  let res;
  if (n.vaciar) res = 'modo vaciar: no clasifica hasta Nivelar.';
  else if (n.atascado) res = 'el residuo no cayó después de inclinar: sácalo a mano o toca Nivelar.';
  else if (n.pausa) res = 'en pausa: no clasifica solo.';
  else if (n.esperando) res = 'ya clasificó lo que hay: espera a que la bandeja quede libre para volver a mirar.';
  else if (n.camVe || n.ultraVe) res = `hay residuo (${[n.ultraVe && 'ultrasónico', n.camVe && 'cámara'].filter(Boolean).join(' y ')}): toma la foto con flash y la manda a la IA.`;
  else res = 'bandeja libre: no hace nada. Si hay algo y no lo detecta, toca "No detectó: guardar y clasificar".';
  $('#dep-paso-res span').textContent = res;
}

function recibirNumeros(n) {
  if (dep.congelado || dep.viendoCaptura) return;
  dep.numeros = n;
  pintarPasos(n);
}

function recibirCuadro(bytes) {
  if (dep.congelado || dep.viendoCaptura) return;
  const cuadro = leerCuadro(bytes);
  if (!cuadro) return;
  pintarCuadro(cuadro);
  $('#dep-fuente').textContent = `En vivo · ${new Date().toLocaleTimeString('es-CO')}`;
}

function volverAVivo() {
  dep.viendoCaptura = null;
  dep.congelado = false;
  $('#dep-congelar').textContent = 'Congelar imagen';
  $('#dep-vivo').hidden = true;
  $('#dep-foto-fig').hidden = true;
  $('#dep-fuente').textContent = 'En vivo: esperando la siguiente imagen de la caneca…';
}

async function abrirCaptura(id) {
  const detalles = $('#depuracion');
  if (!detalles.open) detalles.open = true;
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
    const tipo = app.tiposCaptura[c.tipo] || 'Captura';
    $('#dep-fuente').textContent = `Revisando la captura del ${new Date(c.fecha).toLocaleString('es-CO')} · ${tipo}${c.nota ? ` · «${c.nota}»` : ''}`;
    $('#dep-vivo').hidden = false;
    const fig = $('#dep-foto-fig');
    fig.hidden = !c.foto;
    if (c.foto) $('#dep-foto').src = `/capturas/${id}.jpg`;
    detalles.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    const que = document.createElement('span');
    const datos = [
      Number.isFinite(c.camPct) ? `cámara ${c.camPct} %` : null,
      Number.isFinite(c.dist) && Number.isFinite(c.vacia) ? `ultrasónico ${coma(c.dist)} de ${coma(c.vacia)} cm` : null,
    ].filter(Boolean).join(' · ');
    que.append(enlace(app.tiposCaptura[c.tipo] || 'Captura', '#depuracion', () => abrirCaptura(c.id)));
    if (c.nota) que.append(` «${c.nota}»`);
    if (datos) que.append(` · ${datos}`);
    li.append(cuando, que);
    lista.append(li);
  }
  $('#dep-capturas-vacio').hidden = app.capturas.length > 0;
}

function pintarAjustesCamara() {
  const campos = [['#umbral-cam', app.umbralCamara], ['#zona-x0', app.zona?.x0], ['#zona-x1', app.zona?.x1], ['#zona-y0', app.zona?.y0], ['#zona-y1', app.zona?.y1]];
  for (const [sel, valor] of campos) if (valor !== undefined && valor !== null && document.activeElement !== $(sel)) $(sel).value = valor;
}

$('#depuracion').addEventListener('toggle', () => {
  const abierto = $('#depuracion').open;
  mandar({ t: 'depurar', activo: abierto });
  if (abierto && !dep.viendoCaptura) $('#dep-fuente').textContent = 'En vivo: esperando la primera imagen de la caneca…';
});

$('#dep-congelar').addEventListener('click', () => {
  if (dep.viendoCaptura) return volverAVivo();
  dep.congelado = !dep.congelado;
  $('#dep-congelar').textContent = dep.congelado ? 'Seguir en vivo' : 'Congelar imagen';
  if (dep.congelado) $('#dep-fuente').textContent += ' · CONGELADA';
});
$('#dep-vivo').addEventListener('click', volverAVivo);

for (const boton of document.querySelectorAll('.dep-captura')) {
  boton.addEventListener('click', () => {
    mandar({ t: 'captura', tipo: boton.dataset.tipo, nota: $('#dep-nota').value.trim(), clasificar: boton.dataset.clasificar === '1' });
    $('#dep-nota').value = '';
  });
}

$('#form-camara').addEventListener('submit', (evento) => {
  evento.preventDefault();
  mandar({
    t: 'ajustes',
    umbralCamara: Number($('#umbral-cam').value),
    zona: { x0: Number($('#zona-x0').value), x1: Number($('#zona-x1').value), y0: Number($('#zona-y0').value), y1: Number($('#zona-y1').value) },
  });
});

// ---------------------------------------------------------------------------
// Botones
// ---------------------------------------------------------------------------
document.addEventListener('click', (evento) => {
  const boton = evento.target.closest('[data-orden]');
  if (!boton || boton.disabled) return;
  let accion = boton.dataset.orden;
  if (accion === 'pausa' && app.estado?.pausa) accion = 'reanudar';
  mandar({ t: 'orden', a: accion });
});

// Tomar el control (o ponerse en la fila) con el PIN
$('#form-control').addEventListener('submit', (evento) => {
  evento.preventDefault();
  const pin = $('#pin').value.trim();
  if (!pin) {
    avisar('Escribe el PIN para tomar el control.', 'error');
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
setInterval(pintarActividad, 60000);

$('#pin').value = leerSesion('pin-caneca') || '';
pintarControl();
pintarConexion();
conectar();
