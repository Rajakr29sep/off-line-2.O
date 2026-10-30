(() => {
  const canvas = document.getElementById("resq3dCanvas");
  if (!canvas || !window.THREE) return;
  const THREE = window.THREE;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (error) {
    console.warn("3D illustration unavailable; CSS illustration remains active.", error);
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 7.2);

  const globe = new THREE.Group();
  scene.add(globe);
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.42, 48, 48),
    new THREE.MeshPhongMaterial({ color: 0x176b9b, emissive: 0x062b4a, shininess: 75, transparent: true, opacity: 0.34, wireframe: true })
  );
  globe.add(sphere);
  const inner = new THREE.Mesh(
    new THREE.SphereGeometry(1.25, 40, 40),
    new THREE.MeshBasicMaterial({ color: 0x35bdf2, transparent: true, opacity: 0.055 })
  );
  globe.add(inner);

  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x58c9ff, transparent: true, opacity: 0.55 });
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(1.78, 0.009, 8, 120), ringMaterial);
  ringA.rotation.set(1.1, 0.35, 0.2);
  globe.add(ringA);
  const ringB = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.006, 8, 120), new THREE.MeshBasicMaterial({ color: 0x42e0d0, transparent: true, opacity: 0.38 }));
  ringB.rotation.set(0.35, 1.1, 0.7);
  globe.add(ringB);

  const points = new THREE.Group();
  const pointMaterial = new THREE.MeshBasicMaterial({ color: 0x9cecff });
  const positions = [[-.72,.68,1.05],[.82,.3,1.08],[.25,-.82,1.03],[-1.05,-.12,.85],[.95,-.58,.7]];
  positions.forEach(([x,y,z]) => {
    const marker = new THREE.Mesh(new THREE.SphereGeometry(.055, 12, 12), pointMaterial);
    marker.position.set(x,y,z); points.add(marker);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(.12, 12, 12), new THREE.MeshBasicMaterial({ color: 0x3ecbff, transparent: true, opacity: .16 }));
    glow.position.copy(marker.position); points.add(glow);
  });
  globe.add(points);

  const particleCount = 260;
  const particlePositions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    const radius = 2.1 + Math.random() * 1.1;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    particlePositions[i*3] = radius * Math.sin(phi) * Math.cos(theta);
    particlePositions[i*3+1] = radius * Math.sin(phi) * Math.sin(theta);
    particlePositions[i*3+2] = radius * Math.cos(phi);
  }
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
  const particles = new THREE.Points(particleGeometry, new THREE.PointsMaterial({ color: 0x8bdcff, size: .018, transparent: true, opacity: .7 }));
  scene.add(particles);

  scene.add(new THREE.AmbientLight(0x9bcfff, 1.5));
  const keyLight = new THREE.PointLight(0x46c9ff, 2.4, 12);
  keyLight.position.set(3, 2, 4); scene.add(keyLight);
  const tealLight = new THREE.PointLight(0x35e0c4, 1.2, 10);
  tealLight.position.set(-3, -1, 2); scene.add(tealLight);

  const resize = () => {
    const width = canvas.clientWidth || 240;
    const height = canvas.clientHeight || 210;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas.parentElement);
  else window.addEventListener("resize", resize);

  let pointerX = 0, pointerY = 0;
  canvas.parentElement.addEventListener("pointermove", event => {
    const rect = canvas.parentElement.getBoundingClientRect();
    pointerX = ((event.clientX - rect.left) / rect.width - .5) * .22;
    pointerY = ((event.clientY - rect.top) / rect.height - .5) * .18;
  });
  const clock = new THREE.Clock();
  const animate = () => {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    globe.rotation.y = t * .16 + pointerX;
    globe.rotation.x = Math.sin(t * .22) * .08 + pointerY;
    ringA.rotation.z += .0015;
    ringB.rotation.x += .001;
    particles.rotation.y = -t * .025;
    renderer.render(scene, camera);
  };
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) animate();
  else renderer.render(scene, camera);
})();
