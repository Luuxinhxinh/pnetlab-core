<?php
declare(strict_types=1);

use DI\ContainerBuilder;
use PNetLab\Controllers\NodeController;
use PNetLab\Controllers\SystemController;
use PNetLab\Services\BrokerClient;
use Slim\Factory\AppFactory;

require_once __DIR__ . '/../vendor/autoload.php';

// Setup PSR-11 Dependency Injection Container
$containerBuilder = new ContainerBuilder();
$containerBuilder->addDefinitions([
    BrokerClient::class => fn() => new BrokerClient('/run/pnetlab/broker.sock'),
    NodeController::class => fn($c) => new NodeController($c->get(BrokerClient::class)),
    SystemController::class => fn($c) => new SystemController($c->get(BrokerClient::class)),
]);

$container = $containerBuilder->build();
AppFactory::setContainer($container);

// Create Slim 4 Application
$app = AppFactory::create();
$app->addBodyParsingMiddleware();
$app->addRoutingMiddleware();
$app->addErrorMiddleware(true, true, true);

// Set base path if mounted under /api/v4
$app->setBasePath('/api/v4');

// System Routes
$app->get('/system/status', [SystemController::class, 'status']);
$app->post('/system/fixpermissions', [SystemController::class, 'fixPermissions']);
$app->post('/system/cleanup-network', [SystemController::class, 'cleanupNetwork']);

// Node Lifecycle Routes
$app->post('/labs/nodes/{id}/start', [NodeController::class, 'start']);
$app->post('/labs/nodes/{id}/stop', [NodeController::class, 'stop']);
$app->post('/labs/nodes/{id}/wipe', [NodeController::class, 'wipe']);

return $app;
