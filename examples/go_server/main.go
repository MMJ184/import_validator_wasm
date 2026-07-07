// Go HTTP server — CSV + Excel (XLSX) validation via ImportValidator CGO bindings.
//
// Prerequisites (run from the repo root):
//   ./scripts/build-native.sh                     # build the native library
//   export CGO_CFLAGS="-I$(pwd)/bindings/include"
//   export CGO_LDFLAGS="-L$(pwd)/crates/validator/target/release"
//   export DYLD_LIBRARY_PATH=$(pwd)/crates/validator/target/release  # macOS
//   export LD_LIBRARY_PATH=$(pwd)/crates/validator/target/release    # Linux
//
// Run:
//   cd examples/go_server && go run main.go
//
// Endpoints:
//   POST /validate        multipart form-data: 'file' (CSV) + 'schema' (JSON string)
//   POST /validate/json   JSON body: { "csv": "<base64>", "schema": {...} }
//   POST /validate-xlsx   multipart form-data: 'file' (.xlsx) + 'schema' (JSON string)
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	iv "github.com/mmj/import-validator/bindings/go"
)

// ── Response types ────────────────────────────────────────────────────────────

type errorItem struct {
	Row      uint32  `json:"row"`
	Col      uint32  `json:"col"`
	Column   *string `json:"column"` // resolved column name (null if unknown)
	Kind     string  `json:"kind"`
	Code     uint8   `json:"code"`
	CodeName string  `json:"codeName"`
	Message  string  `json:"message"`
}

type validateResponse struct {
	Valid         bool        `json:"valid"`
	ErrorCount    int         `json:"errorCount"`
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

	schemaStr, ok := requireSchema(w, r)
	if !ok {
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		jsonError(w, "missing 'file' field: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	// ValidateReader streams the CSV through the engine in chunks.
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

// POST /validate-xlsx — accepts multipart: field 'file' (.xlsx), field 'schema' (JSON).
//
// The workbook is buffered fully in memory before validation: XLSX is a ZIP
// container and its central directory sits at the END of the file, so the
// engine needs random access over the complete byte buffer — an upload stream
// cannot be fed to it chunk by chunk the way CSV can.
func handleValidateXlsx(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	if err := r.ParseMultipartForm(128 << 20); err != nil {
		jsonError(w, "cannot parse multipart: "+err.Error(), http.StatusBadRequest)
		return
	}

	schemaStr, ok := requireSchema(w, r)
	if !ok {
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		jsonError(w, "missing 'file' field: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	xlsxBytes, err := io.ReadAll(file)
	if err != nil {
		jsonError(w, "cannot read upload: "+err.Error(), http.StatusBadRequest)
		return
	}

	result, err := iv.ValidateXlsxBytes(xlsxBytes, schemaStr, 10_000, false)
	if err != nil {
		jsonError(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}

	jsonOK(w, buildResponse(result))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// requireSchema pulls the 'schema' form field and checks it is valid JSON.
// On failure it writes the error response and returns ok=false.
func requireSchema(w http.ResponseWriter, r *http.Request) (string, bool) {
	schemaStr := r.FormValue("schema")
	if schemaStr == "" {
		jsonError(w, "missing 'schema' field", http.StatusBadRequest)
		return "", false
	}
	var schema map[string]interface{}
	if err := json.Unmarshal([]byte(schemaStr), &schema); err != nil {
		jsonError(w, "invalid schema JSON: "+err.Error(), http.StatusBadRequest)
		return "", false
	}
	return schemaStr, true
}

func buildResponse(result *iv.ValidationResult) validateResponse {
	items := make([]errorItem, len(result.Errors))
	for i, e := range result.Errors {
		items[i] = errorItem{
			Row:      e.Row,
			Col:      e.Col,
			Column:   e.ColumnName,
			Kind:     e.Kind,
			Code:     e.Code,
			CodeName: e.CodeName,
			Message:  e.Message,
		}
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

	http.HandleFunc("/validate", handleValidateMultipart)
	http.HandleFunc("/validate/json", handleValidateJSON)
	http.HandleFunc("/validate-xlsx", handleValidateXlsx)

	fmt.Printf("ImportValidator Go server listening on http://localhost:%s\n", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
