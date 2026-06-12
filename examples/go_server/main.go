// Go HTTP server — CSV validation via ImportValidator CGO bindings.
//
// Prerequisites:
//   ./scripts/build-native.sh                     # build the native library
//   export CGO_CFLAGS="-I$(pwd)/bindings/include"
//   export LIBRARY_PATH=$(pwd)/crates/validator/target/release
//   export DYLD_LIBRARY_PATH=$LIBRARY_PATH        # macOS
//   export LD_LIBRARY_PATH=$LIBRARY_PATH          # Linux
//
// Run:
//   go run main.go
//
// Endpoints:
//   POST /validate        multipart form-data: 'file' (CSV) + 'schema' (JSON string)
//   POST /validate/json   JSON body: { "csv": "<base64>", "schema": {...} }
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	// Replace with the actual module path once extracted to a standalone module.
	iv "github.com/yourorg/import-validator/bindings/go"
)

// ── Response types ────────────────────────────────────────────────────────────

type errorItem struct {
	Row      uint32 `json:"row"`
	Col      uint32 `json:"col"`
	Kind     string `json:"kind"`
	Code     uint8  `json:"code"`
	CodeName string `json:"codeName"`
}

type validateResponse struct {
	Valid         bool        `json:"valid"`
	ErrorCount    int         `json:"errorCount"`
	RowsProcessed int         `json:"rowsProcessed,omitempty"`
	Errors        []errorItem `json:"errors"`
	SchemaColumns []string    `json:"schemaColumns"`
	InputColumns  []string    `json:"inputColumns"`
}

// ── Handlers ─────────────────────────────────────────────────────────────────

// POST /validate — accepts multipart: field 'file' (CSV), field 'schema' (JSON).
func handleValidateMultipart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	if err := r.ParseMultipartForm(128 << 20); err != nil {
		jsonError(w, "cannot parse multipart: "+err.Error(), http.StatusBadRequest)
		return
	}

	schemaStr := r.FormValue("schema")
	if schemaStr == "" {
		jsonError(w, "missing 'schema' field", http.StatusBadRequest)
		return
	}
	var schema map[string]interface{}
	if err := json.Unmarshal([]byte(schemaStr), &schema); err != nil {
		jsonError(w, "invalid schema JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		jsonError(w, "missing 'file' field: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	result, err := iv.ValidateReader(file, schemaStr, 10_000, false, 0)
	if err != nil {
		jsonError(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}

	jsonOK(w, buildResponse(result))
}

// POST /validate/json — accepts JSON body: { "csv": "<base64>", "schema": {...} }.
func handleValidateJSON(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		jsonError(w, "cannot read body", http.StatusBadRequest)
		return
	}

	var req struct {
		CSV    string          `json:"csv"`
		Schema json.RawMessage `json:"schema"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		jsonError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.CSV == "" {
		jsonError(w, "missing 'csv' field", http.StatusBadRequest)
		return
	}
	if req.Schema == nil {
		jsonError(w, "missing 'schema' field", http.StatusBadRequest)
		return
	}

	csvBytes, err := base64.StdEncoding.DecodeString(req.CSV)
	if err != nil {
		jsonError(w, "invalid base64 CSV: "+err.Error(), http.StatusBadRequest)
		return
	}

	schemaStr := string(req.Schema)
	result, err := iv.ValidateBytes(csvBytes, schemaStr, 10_000, false)
	if err != nil {
		jsonError(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}

	jsonOK(w, buildResponse(result))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func buildResponse(result *iv.ValidationResult) validateResponse {
	items := make([]errorItem, len(result.Errors))
	for i, e := range result.Errors {
		items[i] = errorItem{Row: e.Row, Col: e.Col, Kind: e.Kind, Code: e.Code, CodeName: e.CodeName}
	}
	return validateResponse{
		Valid:         result.Valid,
		ErrorCount:    len(result.Errors),
		Errors:        items,
		SchemaColumns: result.SchemaColumns,
		InputColumns:  result.InputColumns,
	}
}

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/validate",      handleValidateMultipart)
	http.HandleFunc("/validate/json", handleValidateJSON)

	fmt.Printf("ImportValidator Go server listening on http://localhost:%s\n", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
