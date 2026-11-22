import { shared, thumbnail } from "./state.js";

// ---------- Body preview ----------
// WebGL renderer: depth-buffered, smooth-shaded within each SolidWorks face, real model edges from face
// boundaries plus silhouettes of curved faces. Falls back to a simple 2D painter if WebGL is unavailable.

const geometryCache = new WeakMap();
function geometry(entry) {
    if (geometryCache.has(entry)) return geometryCache.get(entry);
    const values = entry.mesh;
    const triangleCount = Math.floor(values.length / 9);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < triangleCount * 9; i++) {
        const axis = i % 3;
        if (values[i] < min[axis]) min[axis] = values[i];
        if (values[i] > max[axis]) max[axis] = values[i];
    }
    const center = min.map((value, axis) => (value + max[axis]) / 2);
    const radius = Math.hypot(...min.map((value, axis) => (max[axis] - value) / 2)) || 1;

    // Which SolidWorks face each triangle came from (older data: every triangle its own face).
    const faceOf = new Int32Array(triangleCount);
    const hasFaces = Array.isArray(entry.meshFaces) && entry.meshFaces.length > 0;
    let t = 0;
    if (hasFaces) entry.meshFaces.forEach((count, face) => { for (let i = 0; i < count && t < triangleCount; i++) faceOf[t++] = face; });
    for (; t < triangleCount; t++) faceOf[t] = -1 - t;

    const points = new Float32Array(triangleCount * 9);
    for (let i = 0; i < triangleCount * 9; i++) points[i] = (values[i] - center[i % 3]) / radius;

    const ids = new Map(), vertexId = new Int32Array(triangleCount * 3), triangleNormal = new Float32Array(triangleCount * 3);
    const smooth = new Map();
    for (let tri = 0; tri < triangleCount; tri++) {
        for (let k = 0; k < 3; k++) {
            const o = tri * 9 + k * 3;
            const key = Math.round(points[o] * 1e5) + "," + Math.round(points[o + 1] * 1e5) + "," + Math.round(points[o + 2] * 1e5);
            if (!ids.has(key)) ids.set(key, ids.size);
            vertexId[tri * 3 + k] = ids.get(key);
        }
        const o = tri * 9;
        const ux = points[o + 3] - points[o], uy = points[o + 4] - points[o + 1], uz = points[o + 5] - points[o + 2];
        const vx = points[o + 6] - points[o], vy = points[o + 7] - points[o + 1], vz = points[o + 8] - points[o + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        triangleNormal.set([nx, ny, nz], tri * 3);
        for (let k = 0; k < 3; k++) {
            const key = vertexId[tri * 3 + k] + ":" + faceOf[tri];
            const sum = smooth.get(key) ?? [0, 0, 0];
            sum[0] += nx; sum[1] += ny; sum[2] += nz;
            smooth.set(key, sum);
        }
    }

    // The part's SolidWorks colors: one per face (faces painted on their own), else the body's or part's.
    const faceColors = hasFaces && Array.isArray(entry.meshColors) && entry.meshColors.length >= entry.meshFaces.length * 3
        ? entry.meshColors : null;
    const bodyColor = Array.isArray(entry.color) && entry.color.length >= 3 ? entry.color : null;
    const hasColor = Boolean(faceColors || bodyColor);
    const colorOf = tri => {
        const face = faceOf[tri];
        if (faceColors && face >= 0) return [faceColors[face * 3], faceColors[face * 3 + 1], faceColors[face * 3 + 2]];
        return bodyColor ?? [0.7, 0.76, 0.83];
    };

    // Interleaved position + normal + color for drawArrays.
    const vertices = new Float32Array(triangleCount * 27);
    for (let tri = 0; tri < triangleCount; tri++) {
        const color = colorOf(tri);
        for (let k = 0; k < 3; k++) {
            const n = smooth.get(vertexId[tri * 3 + k] + ":" + faceOf[tri]);
            const length = Math.hypot(n[0], n[1], n[2]) || 1;
            const o = (tri * 3 + k) * 9, p = tri * 9 + k * 3;
            vertices.set([points[p], points[p + 1], points[p + 2], n[0] / length, n[1] / length, n[2] / length,
                color[0], color[1], color[2]], o);
        }
    }

    // Edges: model edges (face boundaries, open edges) are always drawn; edges inside one curved face
    // are silhouette candidates, drawn when the surface turns away from the viewer.
    const edges = new Map();
    for (let tri = 0; tri < triangleCount; tri++) {
        for (let k = 0; k < 3; k++) {
            const a = vertexId[tri * 3 + k], b = vertexId[tri * 3 + (k + 1) % 3];
            if (a === b) continue;
            const key = a < b ? a + "," + b : b + "," + a;
            let edge = edges.get(key);
            if (!edge) {
                edge = {from: tri * 9 + k * 3, to: tri * 9 + ((k + 1) % 3) * 3, triangles: []};
                edges.set(key, edge);
            }
            edge.triangles.push(tri);
        }
    }
    const feature = [], candidates = [];
    const angleOf = (a, b) => {
        const na = triangleNormal.subarray(a * 3, a * 3 + 3), nb = triangleNormal.subarray(b * 3, b * 3 + 3);
        return (na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]) / ((Math.hypot(...na) * Math.hypot(...nb)) || 1);
    };
    for (const edge of edges.values()) {
        const [a, b] = edge.triangles;
        if (edge.triangles.length !== 2) feature.push(edge);
        else if (faceOf[a] !== faceOf[b]) { if (hasFaces || angleOf(a, b) < 0.9) feature.push(edge); }
        else if (angleOf(a, b) < 0.99999) candidates.push(edge);
    }
    const result = {points, vertices, triangleCount, triangleNormal, feature, candidates, hasColor, buffers: null};
    geometryCache.set(entry, result);
    return result;
}

const shaderSource = {
    project: `
        uniform mat3 rotation; uniform vec2 pan; uniform vec2 scale; uniform float perspective;
        vec4 project(vec3 position) {
            vec3 v = rotation * position;
            v.xy += pan;
            float w = perspective > 0.5 ? (3.0 - v.z) / 3.0 : 1.0;
            return vec4(v.x * scale.x, v.y * scale.y, -v.z * 0.3 * w, w);
        }`,
    meshVertex: `
        attribute vec3 position; attribute vec3 normal; attribute vec3 color;
        varying vec3 viewNormal; varying vec3 surface;
        void main() { viewNormal = rotation * normal; surface = color; gl_Position = project(position); }`,
    meshFragment: `
        precision mediump float;
        varying vec3 viewNormal; varying vec3 surface;
        uniform vec3 baseColor; uniform float useColor;
        uniform vec3 sky; uniform vec3 ground; uniform float gloss; uniform float toon;
        void main() {
            vec3 n = normalize(viewNormal);
            if (n.z < 0.0) n = -n;
            // A key light just above-left of the viewer gives top, left and right faces three distinct tones.
            vec3 key = normalize(vec3(-0.25, 0.2, 0.95));
            vec3 fill = normalize(vec3(0.6, 0.3, 0.4));
            float diffuse = max(dot(n, key), 0.0);
            float fillLight = max(dot(n, fill), 0.0) * 0.06;
            float rim = pow(1.0 - n.z, 3.0) * 0.18;
            if (toon > 0.5) { diffuse = floor(diffuse * 3.0 + 0.4) / 3.0; fillLight = 0.0; rim = 0.0; }
            vec3 ambient = mix(ground, sky, n.y * 0.5 + 0.5);
            vec3 halfway = normalize(key + vec3(0.0, 0.0, 1.0));
            float specular = pow(max(dot(n, halfway), 0.0), gloss > 0.5 ? 70.0 : 22.0) * (gloss > 0.5 ? 0.6 : 0.1);
            if (toon > 0.5) specular = specular > 0.3 ? 0.35 : 0.0;
            // SolidWorks appearance colors are display colors; shade them so their hue stays recognizable.
            vec3 albedo = mix(baseColor, surface, useColor);
            vec3 color = albedo * (ambient + diffuse * 0.6 + fillLight) + vec3(specular + rim);
            gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
        }`,
    lineVertex: `
        attribute vec3 from; attribute vec3 to; attribute vec2 corner;
        uniform vec2 viewport; uniform float width; uniform float lift;
        void main() {
            vec4 a = project(from), b = project(to);
            vec2 sa = a.xy / a.w * viewport * 0.5, sb = b.xy / b.w * viewport * 0.5;
            vec2 direction = sb - sa;
            float length = length(direction);
            direction = length > 0.0001 ? direction / length : vec2(1.0, 0.0);
            vec2 side = vec2(-direction.y, direction.x);
            vec4 p = corner.x < 0.5 ? a : b;
            vec2 offset = side * corner.y * width * 0.5 + direction * (corner.x < 0.5 ? -0.5 : 0.5) * width * 0.5;
            p.xy += offset / (viewport * 0.5) * p.w;
            p.z -= lift * p.w;
            gl_Position = p;
        }`,
    lineFragment: `precision mediump float; uniform vec4 color; void main() { gl_FragColor = color; }`
};

const renderer = (() => {
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl", {antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true});
        if (!gl) return null;
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
            return shader;
        };
        const program = (vertex, fragment) => {
            const result = gl.createProgram();
            gl.attachShader(result, compile(gl.VERTEX_SHADER, shaderSource.project + vertex));
            gl.attachShader(result, compile(gl.FRAGMENT_SHADER, fragment));
            gl.linkProgram(result);
            if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
            return result;
        };
        return {canvas, gl, mesh: program(shaderSource.meshVertex, shaderSource.meshFragment),
            line: program(shaderSource.lineVertex, shaderSource.lineFragment), lines: gl.createBuffer()};
    } catch {
        return null;
    }
})();

const lineCorners = [[0, -1], [0, 1], [1, -1], [0, 1], [1, 1], [1, -1]];
function lineData(points, edges) {
    const data = new Float32Array(edges.length * 48);
    let o = 0;
    for (const edge of edges) {
        for (const [end, side] of lineCorners) {
            data[o++] = points[edge.from]; data[o++] = points[edge.from + 1]; data[o++] = points[edge.from + 2];
            data[o++] = points[edge.to]; data[o++] = points[edge.to + 1]; data[o++] = points[edge.to + 2];
            data[o++] = end; data[o++] = side;
        }
    }
    return data;
}

const defaultView = () => ({yaw: -Math.PI / 4, pitch: 0.6155, zoom: 1, panX: 0, panY: 0});
shared.view = defaultView();

// Rows of Rx(pitch) * Ry(yaw): Y is up, as in SolidWorks.
function rotationRows(currentView) {
    const cy = Math.cos(currentView.yaw), sy = Math.sin(currentView.yaw);
    const cp = Math.cos(currentView.pitch), sp = Math.sin(currentView.pitch);
    return [[cy, 0, sy], [-sp * -sy, cp, -sp * cy], [cp * -sy, sp, cp * cy]];
}

function renderWebGL(entry, width, height, currentView, options) {
    const {gl, canvas, mesh: meshProgram, line: lineProgram} = renderer;
    const shape = geometry(entry);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    if (!shape.buffers) {
        const vertices = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
        gl.bufferData(gl.ARRAY_BUFFER, shape.vertices, gl.STATIC_DRAW);
        const feature = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, feature);
        gl.bufferData(gl.ARRAY_BUFFER, lineData(shape.points, shape.feature), gl.STATIC_DRAW);
        shape.buffers = {vertices, feature};
    }

    const rows = rotationRows(currentView);
    const matrix = new Float32Array([rows[0][0], rows[1][0], rows[2][0], rows[0][1], rows[1][1], rows[2][1], rows[0][2], rows[1][2], rows[2][2]]);
    const fit = currentView.zoom * (options.Perspective ? 0.88 : 0.97);
    const small = Math.min(width, height);
    const setCommon = program => {
        gl.useProgram(program);
        gl.uniformMatrix3fv(gl.getUniformLocation(program, "rotation"), false, matrix);
        gl.uniform2f(gl.getUniformLocation(program, "pan"), currentView.panX, currentView.panY);
        gl.uniform2f(gl.getUniformLocation(program, "scale"), fit * small / width, fit * small / height);
        gl.uniform1f(gl.getUniformLocation(program, "perspective"), options.Perspective ? 1 : 0);
    };
    const dark = document.documentElement.classList.contains("dark");
    const style = options.DisplayStyle ?? "edges";

    if (style !== "wireframe") {
        setCommon(meshProgram);
        gl.uniform3fv(gl.getUniformLocation(meshProgram, "baseColor"), dark ? [0.6, 0.67, 0.75] : [0.7, 0.76, 0.83]);
        gl.uniform1f(gl.getUniformLocation(meshProgram, "useColor"), shape.hasColor && options.PartColors !== false ? 1 : 0);
        gl.uniform3fv(gl.getUniformLocation(meshProgram, "sky"), [0.56, 0.56, 0.58]);
        gl.uniform3fv(gl.getUniformLocation(meshProgram, "ground"), [0.34, 0.34, 0.36]);
        gl.uniform1f(gl.getUniformLocation(meshProgram, "gloss"), options.Gloss ? 1 : 0);
        gl.uniform1f(gl.getUniformLocation(meshProgram, "toon"), options.Cartoon ? 1 : 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, shape.buffers.vertices);
        const position = gl.getAttribLocation(meshProgram, "position"), normal = gl.getAttribLocation(meshProgram, "normal");
        const color = gl.getAttribLocation(meshProgram, "color");
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 36, 0);
        gl.enableVertexAttribArray(normal);
        gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 36, 12);
        gl.enableVertexAttribArray(color);
        gl.vertexAttribPointer(color, 3, gl.FLOAT, false, 36, 24);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1, 1);
        gl.drawArrays(gl.TRIANGLES, 0, shape.triangleCount * 3);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.disableVertexAttribArray(position);
        gl.disableVertexAttribArray(normal);
        gl.disableVertexAttribArray(color);
    }

    const drawEdges = style !== "shaded" || options.Cartoon;
    if (!drawEdges) return;
    // Silhouettes of curved faces for the current view.
    const z = rows[2];
    const silhouette = shape.candidates.filter(edge => {
        const [a, b] = edge.triangles, n = shape.triangleNormal;
        const za = z[0] * n[a * 3] + z[1] * n[a * 3 + 1] + z[2] * n[a * 3 + 2];
        const zb = z[0] * n[b * 3] + z[1] * n[b * 3 + 1] + z[2] * n[b * 3 + 2];
        return za * zb <= 0;
    });
    setCommon(lineProgram);
    const scale = width / 448;
    gl.uniform2f(gl.getUniformLocation(lineProgram, "viewport"), width, height);
    gl.uniform1f(gl.getUniformLocation(lineProgram, "width"), (options.Cartoon ? 2.6 : 1.3) * Math.max(1, scale));
    gl.uniform1f(gl.getUniformLocation(lineProgram, "lift"), style === "wireframe" ? 0 : 0.0015);
    gl.uniform4fv(gl.getUniformLocation(lineProgram, "color"), dark && style === "wireframe" ? [0.78, 0.86, 0.94, 1] : [0.13, 0.2, 0.29, 1]);
    if (style === "wireframe") gl.disable(gl.DEPTH_TEST);
    const from = gl.getAttribLocation(lineProgram, "from"), to = gl.getAttribLocation(lineProgram, "to"), corner = gl.getAttribLocation(lineProgram, "corner");
    const bind = buffer => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(from); gl.vertexAttribPointer(from, 3, gl.FLOAT, false, 32, 0);
        gl.enableVertexAttribArray(to); gl.vertexAttribPointer(to, 3, gl.FLOAT, false, 32, 12);
        gl.enableVertexAttribArray(corner); gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 32, 24);
    };
    bind(shape.buffers.feature);
    gl.drawArrays(gl.TRIANGLES, 0, shape.feature.length * 6);
    if (silhouette.length) {
        gl.bindBuffer(gl.ARRAY_BUFFER, renderer.lines);
        gl.bufferData(gl.ARRAY_BUFFER, lineData(shape.points, silhouette), gl.STREAM_DRAW);
        bind(renderer.lines);
        gl.drawArrays(gl.TRIANGLES, 0, silhouette.length * 6);
    }
    gl.disableVertexAttribArray(from); gl.disableVertexAttribArray(to); gl.disableVertexAttribArray(corner);
    gl.enable(gl.DEPTH_TEST);
}

function drawThumbnail(entry, canvas = thumbnail, currentView = shared.view) {
    const missing = !entry?.mesh?.length;
    if (canvas === thumbnail) {
        thumbnail.hidden = missing;
        document.querySelector("#rotate-hint").hidden = missing;
    }
    if (missing) return;
    const options = shared.input.settings.sheet;
    if (canvas === thumbnail && canvas.clientWidth) {
        // Match the screen's pixel density so lines and edges stay sharp.
        const ratio = window.devicePixelRatio || 1;
        const width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientWidth * ratio * 280 / 448);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    }
    const context = canvas.getContext("2d");
    const {width, height} = canvas;
    context.clearRect(0, 0, width, height);
    if (options.Shadows && (options.DisplayStyle ?? "edges") !== "wireframe") {
        context.save();
        context.translate(width / 2 + currentView.panX * width * 0.3, height * (0.84 - currentView.panY * 0.3));
        context.scale(currentView.zoom, currentView.zoom * 0.19);
        const shadow = context.createRadialGradient(0, 0, 0, 0, 0, width * .3);
        shadow.addColorStop(0, "rgba(0, 0, 0, .34)");
        shadow.addColorStop(1, "transparent");
        context.fillStyle = shadow;
        context.fillRect(-width / 2, -width / 2, width, width);
        context.restore();
    }
    if (renderer) {
        try {
            renderWebGL(entry, width, height, currentView, options);
            context.drawImage(renderer.canvas, 0, 0);
            return;
        } catch { /* fall through to the 2D painter */ }
    }
    drawThumbnail2D(entry, canvas, currentView, options);
}

// Simple fallback when WebGL is unavailable.
function drawThumbnail2D(entry, canvas, currentView, options) {
    const shape = geometry(entry);
    const context = canvas.getContext("2d");
    const {width, height} = canvas;
    const rows = rotationRows(currentView);
    const scale = Math.min(width, height) * 0.45 * currentView.zoom;
    const project = p => {
        const x = rows[0][0] * p[0] + rows[0][1] * p[1] + rows[0][2] * p[2] + currentView.panX;
        const y = rows[1][0] * p[0] + rows[1][1] * p[1] + rows[1][2] * p[2] + currentView.panY;
        const z = rows[2][0] * p[0] + rows[2][1] * p[1] + rows[2][2] * p[2];
        return [width / 2 + x * scale, height / 2 - y * scale, z];
    };
    const triangles = [];
    for (let tri = 0; tri < shape.triangleCount; tri++) {
        const corners = [0, 1, 2].map(k => project(shape.points.subarray(tri * 9 + k * 3, tri * 9 + k * 3 + 3)));
        const n = shape.triangleNormal.subarray(tri * 3, tri * 3 + 3);
        const length = Math.hypot(n[0], n[1], n[2]) || 1;
        const nz = Math.abs(rows[2][0] * n[0] + rows[2][1] * n[1] + rows[2][2] * n[2]) / length;
        triangles.push({corners, depth: corners[0][2] + corners[1][2] + corners[2][2], light: 0.35 + 0.65 * nz});
    }
    triangles.sort((a, b) => a.depth - b.depth);
    for (const {corners, light} of triangles) {
        const tone = Math.round(90 + light * 120);
        context.fillStyle = context.strokeStyle = `rgb(${tone - 8}, ${tone + 4}, ${tone + 18})`;
        context.beginPath();
        corners.forEach(([x, y]) => context.lineTo(x, y));
        context.closePath();
        context.fill();
        context.stroke();
    }
    if ((options.DisplayStyle ?? "edges") === "shaded") return;
    context.strokeStyle = "#223349";
    context.lineWidth = 1.2;
    for (const edge of shape.feature) {
        const a = project(shape.points.subarray(edge.from, edge.from + 3)), b = project(shape.points.subarray(edge.to, edge.to + 3));
        context.beginPath(); context.moveTo(a[0], a[1]); context.lineTo(b[0], b[1]); context.stroke();
    }
}

// Rotate: drag. Pan: right-drag or Shift-drag. Zoom: scroll wheel or +/-. Reset: double-click or 0.
let drag = null;
thumbnail.addEventListener("contextmenu", event => event.preventDefault());
thumbnail.addEventListener("pointerdown", event => {
    drag = {x: event.clientX, y: event.clientY, pan: event.button === 2 || event.button === 1 || event.shiftKey};
    thumbnail.setPointerCapture(event.pointerId);
});
thumbnail.addEventListener("pointermove", event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.pan) {
        const unit = 2 / (Math.min(thumbnail.clientWidth, thumbnail.clientHeight) * 0.9 * shared.view.zoom);
        shared.view.panX += dx * unit;
        shared.view.panY -= dy * unit;
    } else {
        shared.view.yaw += dx * Math.PI / Math.max(160, thumbnail.clientWidth);
        shared.view.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, shared.view.pitch + dy * Math.PI / Math.max(160, thumbnail.clientHeight)));
    }
    drawThumbnail(shared.input.entries[shared.focused]);
});
thumbnail.addEventListener("lostpointercapture", () => { drag = null; });
thumbnail.addEventListener("wheel", event => {
    event.preventDefault();
    shared.view.zoom = Math.max(0.4, Math.min(12, shared.view.zoom * Math.exp(-event.deltaY * 0.0015)));
    drawThumbnail(shared.input.entries[shared.focused]);
}, {passive: false});
thumbnail.addEventListener("dblclick", () => {
    shared.view = defaultView();
    drawThumbnail(shared.input.entries[shared.focused]);
});
thumbnail.addEventListener("keydown", event => {
    const step = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
    if (step) {
        shared.view.yaw += step[0] * 0.18;
        shared.view.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, shared.view.pitch + step[1] * 0.18));
    } else if (event.key === "+" || event.key === "=") shared.view.zoom = Math.min(12, shared.view.zoom * 1.2);
    else if (event.key === "-" || event.key === "_") shared.view.zoom = Math.max(0.4, shared.view.zoom / 1.2);
    else if (event.key === "0") shared.view = defaultView();
    else return;
    event.preventDefault();
    drawThumbnail(shared.input.entries[shared.focused]);
});
window.addEventListener("resize", () => { if (shared.input && shared.focused >= 0) drawThumbnail(shared.input.entries[shared.focused]); });

export { defaultView, drawThumbnail };
