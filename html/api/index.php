<?php
declare(strict_types=1);

use DI\ContainerBuilder;
use PNetLab\Controllers\AuthController;
use PNetLab\Controllers\FolderController;
use PNetLab\Controllers\LabController;
use PNetLab\Controllers\NodeController;
use PNetLab\Controllers\SystemController;
use PNetLab\Middleware\AuthMiddleware;
use PNetLab\Middleware\RateLimitMiddleware;
use PNetLab\Services\BrokerClient;
use Slim\Factory\AppFactory;

require_once __DIR__ . '/../vendor/autoload.php';

// 1. Setup PSR-11 Dependency Injection Container
$containerBuilder = new ContainerBuilder();
$containerBuilder->addDefinitions([
    PDO::class => function () {
        $host = '127.0.0.1';
        $db   = 'pnetlab_db';
        $user = 'root';
        $pass = '';
        $charset = 'utf8mb4';
        $dsn = "mysql:host=$host;dbname=$db;charset=$charset";
        $opt = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ];
        return new PDO($dsn, $user, $pass, $opt);
    },
    BrokerClient::class => fn() => new BrokerClient('/run/pnetlab/broker.sock'),
    AuthController::class => fn($c) => new AuthController($c->get(PDO::class)),
    FolderController::class => fn() => new FolderController('/opt/unetlab/labs'),
    LabController::class => fn($c) => new LabController($c->get(PDO::class), $c->get(BrokerClient::class), '/opt/unetlab/labs'),
    NodeController::class => fn($c) => new NodeController($c->get(BrokerClient::class)),
    SystemController::class => fn($c) => new SystemController($c->get(BrokerClient::class)),
    AuthMiddleware::class => fn() => new AuthMiddleware(true),
    RateLimitMiddleware::class => fn() => new RateLimitMiddleware(60, 60),
]);

$container = $containerBuilder->build();
AppFactory::setContainer($container);

// 2. Create Slim 4 Application
$app = AppFactory::create();
$app->addBodyParsingMiddleware();
$app->addRoutingMiddleware();

// 3. Register Global Foundation Middlewares (LIFO order in Slim 4)
$app->add($container->get(RateLimitMiddleware::class));
$app->add($container->get(AuthMiddleware::class));
$app->addErrorMiddleware(true, true, true);

// 4. Set base path if mounted under /api/v4
$app->setBasePath('/api/v4');

// 5. System Routes
$app->get('/system/status', [SystemController::class, 'status']);
$app->post('/system/fixpermissions', [SystemController::class, 'fixPermissions']);
$app->post('/system/cleanup-network', [SystemController::class, 'cleanupNetwork']);

// 6. Authentication Routes (Migrated from api.php)
$app->post('/auth/login', [AuthController::class, 'login']);
$app->get('/auth/status', [AuthController::class, 'status']);
$app->post('/auth/logout', [AuthController::class, 'logout']);

// 7. Folder Management Routes (Migrated from api.php)
$app->get('/folders', [FolderController::class, 'list']);

// 8. Lab Topology & Batch Routes (Migrated from api.php)
$app->get('/labs/{path:.+}', [LabController::class, 'get']);
$app->post('/labs/start-all', [LabController::class, 'startAll']);
$app->post('/labs/stop-all', [LabController::class, 'stopAll']);

// 9. Node Lifecycle Routes
$app->post('/labs/nodes/{id}/start', [NodeController::class, 'start']);
$app->post('/labs/nodes/{id}/stop', [NodeController::class, 'stop']);
$app->post('/labs/nodes/{id}/wipe', [NodeController::class, 'wipe']);

return $app;
