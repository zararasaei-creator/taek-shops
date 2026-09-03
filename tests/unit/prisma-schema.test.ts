// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
const schema = readFileSync(schemaPath, "utf8");

/** Strip `//` line comments so they don't create false matches. */
const code = schema
  .split("\n")
  .map((line) => line.replace(/\/\/.*$/, ""))
  .join("\n");

/** Extract each `model X { ... }` block. */
function models(): { name: string; body: string }[] {
  const result: { name: string; body: string }[] = [];
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    result.push({ name: match[1]!, body: match[2]! });
  }
  return result;
}

const allModels = models();

describe("prisma schema — structure", () => {
  it("defines a non-trivial number of models", () => {
    expect(allModels.length).toBeGreaterThanOrEqual(25);
  });

  it("every model has a primary key (`@id` or `@@id`)", () => {
    for (const model of allModels) {
      const hasFieldId = /\s@id(\s|\()/.test(model.body);
      const hasCompositeId = /@@id\(/.test(model.body);
      expect(hasFieldId || hasCompositeId, `${model.name} has no primary key`).toBe(true);
    }
  });

  it("every single-column id uses cuid()", () => {
    for (const model of allModels) {
      const idLine = model.body.split("\n").find((line) => /\s@id(\s|\()/.test(line));
      if (!idLine) continue; // composite @@id models
      expect(idLine, `${model.name}.id is not @default(cuid())`).toMatch(/@default\(cuid\(\)\)/);
    }
  });
});

describe("prisma schema — money is integer cents", () => {
  it("contains no Float fields anywhere", () => {
    const floatFields = code.split("\n").filter((line) => /^\s*\w+\s+Float\b/.test(line));
    expect(floatFields).toEqual([]);
  });

  it("every *Cents field is typed Int", () => {
    const centsFields = code
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\w*[Cc]ents\w*\s+/.test(line) || /^\w+Cents\b/.test(line));

    // Sanity: we actually found money fields to check.
    expect(centsFields.length).toBeGreaterThan(10);

    for (const line of centsFields) {
      expect(line, `money field not Int: "${line}"`).toMatch(/^\w+\s+Int(\?|\b)/);
    }
  });

  it("no *Cents field is Decimal or Float", () => {
    const badMoney = code
      .split("\n")
      .filter((line) => /\w*[Cc]ents\w*\s+(Decimal|Float)\b/.test(line));
    expect(badMoney).toEqual([]);
  });

  it("only rate/percentage fields use Decimal", () => {
    const decimalFields = code
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\w+\s+Decimal(\?|\b)/.test(line))
      .map((line) => line.split(/\s+/)[0]);
    expect(decimalFields.sort()).toEqual(["percentage", "rate"]);
  });
});

describe("prisma schema — critical unique constraints", () => {
  const uniques: [model: string, field: string][] = [
    ["User", "email"],
    ["Category", "slug"],
    ["Brand", "slug"],
    ["Product", "slug"],
    ["ProductVariant", "sku"],
    ["Order", "orderNumber"],
    ["Discount", "code"],
    ["Session", "tokenHash"],
  ];

  it.each(uniques)("%s.%s is @unique", (modelName, field) => {
    const model = allModels.find((m) => m.name === modelName);
    expect(model, `model ${modelName} missing`).toBeDefined();
    const fieldLine = model!.body
      .split("\n")
      .find((line) => new RegExp(`^\\s*${field}\\s`).test(line));
    expect(fieldLine, `${modelName}.${field} missing`).toBeDefined();
    expect(fieldLine!, `${modelName}.${field} not @unique`).toMatch(/@unique/);
  });

  it("ImportJobRow enforces one row per (job, rowNumber)", () => {
    const model = allModels.find((m) => m.name === "ImportJobRow");
    expect(model!.body).toMatch(/@@unique\(\[importJobId,\s*rowNumber\]\)/);
  });

  it("OrderAddress enforces one address per (order, type)", () => {
    const model = allModels.find((m) => m.name === "OrderAddress");
    expect(model!.body).toMatch(/@@unique\(\[orderId,\s*type\]\)/);
  });
});

describe("prisma schema — timestamps", () => {
  it("mutable catalogue/commerce models carry createdAt + updatedAt", () => {
    for (const name of ["User", "Product", "ProductVariant", "Order", "InventoryItem"]) {
      const model = allModels.find((m) => m.name === name)!;
      expect(model.body, `${name}.createdAt`).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/);
      expect(model.body, `${name}.updatedAt`).toMatch(/updatedAt\s+DateTime\s+@updatedAt/);
    }
  });

  it("append-only ledgers have createdAt but no updatedAt", () => {
    for (const name of ["StockMovement", "OrderAddress", "OrderDiscount"]) {
      const model = allModels.find((m) => m.name === name)!;
      expect(model.body, `${name}.createdAt`).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/);
      expect(model.body, `${name} should not have updatedAt`).not.toMatch(/@updatedAt/);
    }
  });
});

describe("prisma schema — currency defaults to CAD", () => {
  it("every currency field defaults to CAD", () => {
    const currencyLines = code
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^currency\s+Currency/.test(line));
    expect(currencyLines.length).toBeGreaterThan(0);
    for (const line of currencyLines) {
      expect(line).toMatch(/@default\(CAD\)/);
    }
  });
});
