# ==============================================================================
# AEGIS-T2A OPA Policy Engine Dockerfile
# ==============================================================================

FROM openpolicyagent/opa:latest-static

# Copy policy bundles
COPY src/governance/policy/opa/ /policies/

# Create bundle
WORKDIR /policies

# OPA configuration
ENV OPA_LOG_LEVEL=info

EXPOSE 8181

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8181/health || exit 1

# Run OPA server with policies
CMD ["run", "--server", "--addr=0.0.0.0:8181", "--log-level=${OPA_LOG_LEVEL}", "/policies"]
