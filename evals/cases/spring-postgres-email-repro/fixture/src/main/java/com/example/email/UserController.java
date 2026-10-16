package com.example.email;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users")
public class UserController {
    private final UserService service;

    public UserController(UserService service) {
        this.service = service;
    }

    @GetMapping("/lookup")
    public ResponseEntity<String> lookup(@RequestParam String email) {
        return service.findByEmail(email)
                .map(user -> ResponseEntity.ok(user.getEmail()))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
