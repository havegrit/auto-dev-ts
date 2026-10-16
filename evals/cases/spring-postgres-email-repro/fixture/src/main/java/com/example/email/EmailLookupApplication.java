package com.example.email;

import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class EmailLookupApplication {
    public static void main(String[] args) {
        SpringApplication.run(EmailLookupApplication.class, args);
    }

    @Bean
    CommandLineRunner seedUser(UserRepository repository) {
        return args -> {
            if (repository.findByEmail("lee@example.com").isEmpty()) {
                repository.save(new User("lee@example.com"));
            }
        };
    }
}
