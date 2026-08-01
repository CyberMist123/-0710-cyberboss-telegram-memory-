#!/usr/bin/env python3
import ast
import json
import unittest
from collections import Counter
from pathlib import Path


TESTS_DIR = Path(__file__).resolve().parent
KIT = TESTS_DIR.parent
REPOSITORY = Path(__file__).resolve().parents[4]
CATALOG_PATH = REPOSITORY / "docs" / "console" / "route-catalog.json"
REQUIRED_FIELDS = {
    "method",
    "path",
    "status",
    "auth",
    "side_effect",
    "test_id",
}


def _path_attribute_name(node):
    if not isinstance(node, ast.Attribute) or node.attr != "path":
        return None
    if isinstance(node.value, ast.Name):
        return node.value.id
    return None


def _literal_paths(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value] if node.value.startswith("/") else []
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        paths = []
        for item in node.elts:
            paths.extend(_literal_paths(item))
        return paths
    return []


def _routes_from_handler(source_path, method_name):
    tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
    handler = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "H":
            handler = next(
                (
                    item
                    for item in node.body
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and item.name == method_name
                ),
                None,
            )
            break
    if handler is None:
        return set()

    paths = set()
    for node in ast.walk(handler):
        if not isinstance(node, ast.Compare):
            continue
        operands = [node.left, *node.comparators]
        if not any(_path_attribute_name(item) for item in operands):
            continue
        for operand in operands:
            paths.update(_literal_paths(operand))
    return paths


def actual_routes():
    routes = {
        ("GET", path)
        for path in _routes_from_handler(KIT / "dashboard.py", "do_GET")
    }
    routes.update(
        ("GET", path)
        for path in _routes_from_handler(KIT / "dashboard_continuity.py", "do_GET")
    )
    routes.update(
        ("POST", path)
        for path in _routes_from_handler(KIT / "dashboard.py", "do_POST")
    )
    return routes


class DashboardRouteCatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))

    def test_catalog_schema_and_counts(self):
        self.assertIsInstance(self.catalog, list)
        self.assertEqual(len(self.catalog), 50)
        self.assertTrue(all(set(row) == REQUIRED_FIELDS for row in self.catalog))
        self.assertTrue(all(row["method"] in {"GET", "POST"} for row in self.catalog))
        self.assertTrue(
            all(row["status"] in {"active", "frozen", "retired", "compat"} for row in self.catalog)
        )
        self.assertTrue(all(row["path"].startswith("/") for row in self.catalog))
        self.assertTrue(all(row["auth"] for row in self.catalog))
        self.assertTrue(all(row["side_effect"] for row in self.catalog))
        self.assertEqual(len({row["test_id"] for row in self.catalog}), 50)

        methods = Counter(row["method"] for row in self.catalog)
        statuses = Counter(row["status"] for row in self.catalog)
        self.assertEqual(methods, {"GET": 32, "POST": 18})
        self.assertEqual(
            statuses,
            {"active": 33, "compat": 8, "frozen": 7, "retired": 2},
        )

    def test_catalog_matches_both_real_dispatchers_exactly(self):
        catalog_routes = {(row["method"], row["path"]) for row in self.catalog}
        self.assertEqual(len(catalog_routes), 50, "catalog contains duplicate method/path entries")
        self.assertSetEqual(catalog_routes, actual_routes())

    def test_auth_contract_matches_route_status(self):
        for row in self.catalog:
            with self.subTest(method=row["method"], path=row["path"]):
                if row["method"] == "GET":
                    self.assertEqual(row["auth"], "local-only")
                elif row["status"] == "frozen":
                    self.assertEqual(row["auth"], "frozen-before-auth")
                else:
                    self.assertEqual(row["auth"], "x-api-token")


if __name__ == "__main__":
    unittest.main(verbosity=2)
