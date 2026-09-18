import { expect, test } from "bun:test";

import { ranked } from "@/lib/ranking";
import type { Band, Row } from "@/lib/ranking";

function row(value: string): Row {
  return { value };
}

const project: Band<Row> = {
  title: "project",
  rows: [row("project reship the tag"), row("project ship the branch")],
};

const home: Band<Row> = {
  title: "home",
  rows: [row("home ship"), row("home greet the crew")],
};

test("no search keeps every row where it was declared", () => {
  const found = ranked([project, home], "");
  expect(found.bands).toEqual([project, home]);
  expect(found.top).toBe("project reship the tag");
});

test("a search leads with the best row, and with the band holding it", () => {
  const found = ranked([project, home], "ship");
  expect(found.bands.map((band) => band.title)).toEqual(["home", "project"]);
  expect(found.bands[1]?.rows.map((one) => one.value)).toEqual([
    "project ship the branch",
    "project reship the tag",
  ]);
  expect(found.top).toBe("home ship");
});

test("rows a longer search drops leave the list, and the top moves on", () => {
  const grown: Band<Row> = { ...home, rows: [...home.rows, row("home ship-local deploy")] };
  const found = ranked([project, grown], "ship-l");
  expect(found.bands.map((band) => band.rows.map((one) => one.value))).toEqual([
    ["home ship-local deploy"],
  ]);
  expect(found.top).toBe("home ship-local deploy");
});

test("rows the catalogs bring later take the top", () => {
  expect(ranked([project], "ship").top).toBe("project ship the branch");
  expect(ranked([project, home], "ship").top).toBe("home ship");
});

test("a row nothing can start is never the top", () => {
  const stuck: Band<Row> = { title: "home", rows: [{ value: "home ship", disabled: true }] };
  const found = ranked([project, stuck], "ship");
  expect(found.bands.map((band) => band.title)).toEqual(["home", "project"]);
  expect(found.top).toBe("project ship the branch");
});

test("a search nothing matches leaves no band and no top", () => {
  expect(ranked([project, home], "zz")).toEqual({ bands: [], top: undefined });
});
