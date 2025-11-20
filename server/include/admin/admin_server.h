#ifndef ADMIN_SERVER_H
#define ADMIN_SERVER_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

// Forward declarations
struct Sim;
struct NetworkManager;

// Admin server configuration
#define ADMIN_DEFAULT_PORT 8081
#define ADMIN_MAX_CONNECTIONS 10
#define ADMIN_BUFFER_SIZE 4096
#define ADMIN_MAX_CLIENTS 5

// Admin server context
struct AdminServer {
    int socket_fd;
    uint16_t port;
    bool running;
    
    // Client connections
    struct AdminClient {
        int socket_fd;
        bool active;
        char request_buffer[ADMIN_BUFFER_SIZE];
        size_t request_length;
        uint32_t last_activity;
    } clients[ADMIN_MAX_CLIENTS];
    
    // Statistics
    uint32_t total_requests;
    uint32_t total_connections;
    uint32_t start_time;
};

// HTTP request types
typedef enum {
    HTTP_GET = 0,
    HTTP_POST,
    HTTP_PUT,
    HTTP_DELETE,
    HTTP_UNKNOWN
} http_method_t;

struct HttpRequest {
    http_method_t method;
    char path[256];
    char query_string[512];
    char* body;
    size_t body_length;
    char headers[1024];
};

struct HttpResponse {
    int status_code;
    const char* content_type;
    const char* body;
    size_t body_length;
    bool cache_control;
};

// Admin server lifecycle
int admin_server_init(struct AdminServer* admin, uint16_t port);
void admin_server_cleanup(struct AdminServer* admin);
int admin_server_update(struct AdminServer* admin, const struct Sim* sim, 
                       const struct NetworkManager* net_mgr);

// HTTP request handling
int admin_parse_request(const char* request_data, size_t length, struct HttpRequest* req);
int admin_handle_request(const struct HttpRequest* req, struct HttpResponse* resp,
                        const struct Sim* sim, const struct NetworkManager* net_mgr);
int admin_send_response(int client_fd, const struct HttpResponse* resp);

// API endpoints
int admin_api_status(struct HttpResponse* resp, const struct Sim* sim,
                    const struct NetworkManager* net_mgr);
int admin_api_entities(struct HttpResponse* resp, const struct Sim* sim);
int admin_api_physics_objects(struct HttpResponse* resp, const struct Sim* sim);
int admin_api_network_stats(struct HttpResponse* resp, const struct NetworkManager* net_mgr);
int admin_api_performance(struct HttpResponse* resp, const struct Sim* sim);
int admin_api_map_data(struct HttpResponse* resp, const struct Sim* sim);
int admin_api_message_stats(struct HttpResponse* resp);
int admin_api_input_tiers(struct HttpResponse* resp);

// Static content serving
int admin_serve_dashboard(struct HttpResponse* resp);
int admin_serve_css(struct HttpResponse* resp);
int admin_serve_js(struct HttpResponse* resp);

// Utility functions
const char* admin_get_mime_type(const char* path);
void admin_url_decode(char* str);
int admin_parse_query_params(const char* query, char params[][2][256], int max_params);

#endif // ADMIN_SERVER_H