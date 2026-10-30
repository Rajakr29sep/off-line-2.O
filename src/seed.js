// Demo data. Everything created here is flagged is_sample = 1 and labelled "(sample)" in the UI.
// Run `npm run reset-demo` to wipe data/offlineaid.db and reseed.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { get, run, now, tx, DATA_DIR } = require("./db");
const { hashPin } = require("./auth");
const { validateGraph, computeRoute } = require("./indoor");

const ORG_ID = "org-sunrise";
const FP_ID = "FP-sample-plant2";

const DEMO_USERS = [
  ["admin", "Meera Iyer", "administrator", "Facility Administrator", ORG_ID, "1111"],
  ["officer", "Rahul Verma", "officer", "Safety Officer", ORG_ID, "2222"],
  ["emp1", "Arjun Mehta", "employee", "Line A Technician", ORG_ID, "3333"],
  ["emp2", "Kavya Rao", "employee", "Warehouse Supervisor", ORG_ID, "4444"],
  ["citizen", "Demo Citizen", "citizen", null, null, "5555"],
  ["gov", "District Control Room", "government_operator", "Duty Operator", null, "6666"],
  ["other-officer", "Neha Singh", "officer", "Safety Officer", "org-harbor", "7777"],
];

// Sample factory graph — pixel coordinates on sample_data/factory_floorplan.png (1600x980).
const N = (id, x, y, type, label) => ({ id, x, y, type, label, blocked: false, floorId: "ground" });
const NODES = [
  N("R_A", 285, 380, "room", "Assembly Line A"), N("R_B", 700, 380, "room", "Assembly Line B"),
  N("R_P", 1040, 390, "room", "Paint Shop"), N("H_P", 1040, 270, "hazard", "Solvent spray booths"),
  N("R_CHEM", 1275, 230, "restricted", "Chemical Store (restricted)"), N("R_EL", 1275, 395, "room", "Electrical Room"),
  N("R_WH", 345, 720, "room", "Warehouse"), N("R_CT", 760, 730, "room", "Canteen"),
  N("R_FA", 1010, 640, "first_aid", "First Aid Room"), N("R_QA", 1200, 640, "room", "QA Lab"),
  N("STAIRS", 1325, 630, "stairs", "Stairs to mezzanine"), N("R_OFF", 1145, 800, "room", "Offices"),
  N("D_A", 280, 440, "corridor", "Line A door"), N("D_B", 700, 440, "corridor", "Line B door"),
  N("D_P", 1040, 440, "corridor", "Paint Shop door"), N("D_EL", 1265, 440, "corridor", "Electrical door"),
  N("D_WH", 340, 540, "corridor", "Warehouse door"), N("D_CT", 760, 540, "corridor", "Canteen door"),
  N("D_FA", 1010, 540, "corridor", "First Aid door"), N("D_QA", 1250, 540, "corridor", "QA Lab door"),
  N("C1", 150, 490, "corridor", "Corridor W"), N("C2", 310, 490, "corridor", "Corridor 2"),
  N("C3", 520, 490, "corridor", "Corridor 3"), N("C4", 730, 490, "corridor", "Corridor 4"),
  N("C5", 900, 490, "corridor", "Corridor 5"), N("C6", 1040, 490, "corridor", "Corridor 6 (Paint Shop)"),
  N("C7", 1260, 490, "corridor", "Corridor 7"), N("C8", 1330, 490, "corridor", "Corridor E"),
  N("EXIT_W", 80, 490, "exit", "West Exit"), N("EXIT_E", 1380, 490, "exit", "East Exit"),
  N("EXIT_S", 760, 880, "exit", "South Exit"),
  N("W_OUT", 35, 490, "corridor", "West footpath"), N("W_SOUTH", 35, 935, "corridor", "South-west footpath"),
  N("AP_S", 760, 935, "assembly", "Assembly Point B — South Gate"), N("S_PATH", 1490, 935, "corridor", "South-east footpath"),
  N("E_YARD", 1490, 490, "corridor", "East yard path"), N("AP_E", 1490, 760, "assembly", "Assembly Point A — East Yard"),
  N("EXT1", 520, 455, "extinguisher", "Extinguisher (CO2)"), N("EXT2", 1110, 455, "extinguisher", "Extinguisher (foam)"),
  N("EXT3", 700, 860, "extinguisher", "Extinguisher (canteen)"),
];
const E = [
  ["R_A", "D_A"], ["D_A", "C2"], ["R_B", "D_B"], ["D_B", "C4"], ["R_P", "D_P"], ["D_P", "C6"], ["R_P", "H_P"],
  ["R_EL", "D_EL"], ["D_EL", "C7"], ["R_WH", "D_WH"], ["D_WH", "C2"], ["R_CT", "D_CT"], ["D_CT", "C4"],
  ["R_FA", "D_FA"], ["D_FA", "C6"], ["R_QA", "D_QA"], ["D_QA", "C7"], ["R_QA", "STAIRS"], ["R_QA", "R_OFF"],
  ["C1", "C2"], ["C2", "C3"], ["C3", "C4"], ["C4", "C5"], ["C5", "C6"], ["C6", "C7"], ["C7", "C8"],
  ["C1", "EXIT_W"], ["C8", "EXIT_E"], ["R_CT", "EXIT_S"],
  ["EXIT_W", "W_OUT"], ["W_OUT", "W_SOUTH"], ["W_SOUTH", "AP_S"], ["EXIT_S", "AP_S"], ["AP_S", "S_PATH"],
  ["S_PATH", "AP_E"], ["EXIT_E", "E_YARD"], ["E_YARD", "AP_E"],
];

function seed() {
  if (get("SELECT id FROM organisations LIMIT 1")) return false;
  const t = now();
  const graph = validateGraph(NODES, E.map(([source, destination]) => ({ source, destination })));
  const orgDir = path.join(DATA_DIR, "uploads", "floorplans", ORG_ID);
  fs.mkdirSync(orgDir, { recursive: true });
  const sampleDir = path.join(__dirname, "..", "sample_data");
  fs.copyFileSync(path.join(sampleDir, "factory_floorplan.png"), path.join(orgDir, `${FP_ID}.png`));
  fs.copyFileSync(path.join(sampleDir, "factory_floorplan.pdf"), path.join(orgDir, `${FP_ID}.pdf`));

  tx(() => {
    run("INSERT INTO organisations (id, name, type, facility_name, is_sample, created_at) VALUES (?,?,?,?,1,?)",
      ORG_ID, "Sunrise Components Pvt. Ltd. (sample)", "factory", "Plant 2 — Assembly Hall", t);
    run("INSERT INTO organisations (id, name, type, facility_name, is_sample, share_with_government, created_at) VALUES (?,?,?,?,1,0,?)",
      "org-harbor", "Harbor Logistics (sample, isolation test)", "warehouse", "Dock 4", t);
    for (const [username, name, role, job, org, pin] of DEMO_USERS) {
      run(`INSERT INTO users (id, username, name, role, job_title, organisation_id, pin_hash, is_sample, created_at)
        VALUES (?,?,?,?,?,?,?,1,?)`, `usr-${username}`, username, name, role, job, org, hashPin(pin), t);
    }
    run(`INSERT INTO floor_plans (id, organisation_id, name, floor, image_path, original_path, width, height, nodes, edges, is_sample, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`, FP_ID, ORG_ID, "Plant 2 — Ground floor (sample)", "Ground",
    path.join("uploads", "floorplans", ORG_ID, `${FP_ID}.png`), path.join("uploads", "floorplans", ORG_ID, `${FP_ID}.pdf`),
    1600, 980, JSON.stringify(graph.nodes), JSON.stringify(graph.edges), t, t);

    const plans = [
      ["EVP-sample-fire", "Fire evacuation — Assembly Line A", "fire", "R_A", "nearest_assembly", [],
        "1. Raise the alarm and stop machines (emergency stop).\n2. Do not use the Paint Shop corridor if smoke is visible.\n3. Walk — do not run — along the highlighted route.\n4. Close doors behind you to slow smoke.\n5. Report to the assembly point warden and tap \"I am safe\"."],
      ["EVP-sample-quake", "Earthquake response — Warehouse", "earthquake", "R_WH", "nearest_safe", [],
        "1. DROP, COVER and HOLD until shaking stops — stay away from racking.\n2. When shaking stops, evacuate via the highlighted route.\n3. Avoid the Chemical Store and Electrical Room.\n4. Report at the assembly point."],
      ["EVP-sample-medical", "Medical emergency — Line B to First Aid", "medical", "R_B", "R_FA", [],
        "1. Call the Safety Officer from OfflineAid (SOS → Medical).\n2. Bring the casualty to the First Aid Room only if safe to move.\n3. Collect the first-aid kit and AED on the way."],
    ];
    for (const [id, name, type, start, dest, blocked, instructions] of plans) {
      const r = computeRoute(graph, { start, destination: dest, blockedNodes: blocked });
      run(`INSERT INTO evacuation_plans (id, organisation_id, floor_plan_id, name, emergency_type, start_node, destination_node, route,
        blocked_nodes, instructions, is_sample, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      id, ORG_ID, FP_ID, name, type, start, dest, JSON.stringify(r.ok ? r.path : []), JSON.stringify(blocked), instructions, t, t);
    }

    // Two simulated citizen incidents inside the map region so Government Mode has something to show.
    const samples = [
      ["flood", "[SAMPLE] Water logging, family of 4 needs help leaving ground floor.", 4, 28.6315, 77.2295],
      ["medical", "[SAMPLE] Elderly person with chest pain, road blocked by water.", 1, 28.6205, 77.2105],
    ];
    samples.forEach(([cat, desc, people, lat, lon], i) => {
      run(`INSERT INTO emergency_requests (id, client_id, organisation_id, sender_id, sender_name, sender_role, category, description,
        people_affected, latitude, longitude, created_at, updated_at, is_sample) VALUES (?,?,NULL,'usr-citizen','Demo Citizen','citizen',?,?,?,?,?,?,?,1)`,
      `REQ-sample-${i + 1}`, `sample-${crypto.randomUUID()}`, cat, desc, people, lat, lon, t, t);
    });
  });
  console.log("[seed] Demo organisation, accounts, floor plan and plans created (all labelled sample).");
  return true;
}

module.exports = { seed, DEMO_USERS };
